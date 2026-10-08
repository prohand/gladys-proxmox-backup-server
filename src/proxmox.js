import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { logger } from '@gladysassistant/integration-sdk';

// PBS returns the task history newest-first and paginated. We walk one page at
// a time until every maintenance task type we care about has been seen, rather
// than hoping the newest GC/prune/verify fits in a single fixed window.
export const TASK_PAGE_SIZE = 500;
export const TASK_MAX_PAGES = 4;

export const TASK_TYPE_ALIASES = {
  verify: [
    'verify',
    'verify-group',
    'verify-snapshot',
    'verify_group',
    'verify_snapshot',
    'verification',
    'verificationjob',
    'verifyjob',
    'verifysnapshot',
  ],
  gc: ['garbage_collection', 'garbage-collection', 'gc'],
  prune: ['prune', 'prunejob'],
};

// One request must never outlive this, whatever the server does: a PBS that
// accepts the connection, then stalls in the middle of its answer, used to
// leave the poll (and every widget or scene action waiting on it) pending
// forever, with no red status anywhere. The deadline covers the whole exchange,
// not only the socket's idle time.
export const REQUEST_TIMEOUT_MS = 15_000;
// A task page is a few hundred kilobytes at most; refuse to buffer more than
// this so a misbehaving host cannot balloon the container's memory.
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * An error raised while talking to the PBS API. `kind` is what the code acts
 * on ('config' | 'auth' | 'permission' | 'tls' | 'network' | 'timeout' |
 * 'http' | 'parse'), `messages` is what the user reads, in both languages.
 */
export class ProxmoxError extends Error {
  constructor(kind, messages, { status, path } = {}) {
    super(messages.en);
    this.name = 'ProxmoxError';
    this.kind = kind;
    this.messages = messages;
    this.status = status;
    this.path = path;
  }
}

/**
 * A certificate fingerprint in comparable form: upper case, no separator. PBS
 * shows `AA:BB:...` (`proxmox-backup-manager cert info`), users paste all kinds
 * of variants.
 */
export function normalizeFingerprint(value) {
  return String(value ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

/**
 * How the TLS handshake is validated: `fingerprint` (the certificate must have
 * the pinned SHA-256 fingerprint, which accepts a self-signed one safely),
 * `ca` (the usual chain of trust) or `none` (encrypted, not authenticated).
 */
export function resolveTlsMode(config) {
  const fingerprint = normalizeFingerprint(config.tls_fingerprint);
  if (fingerprint) return { mode: 'fingerprint', fingerprint };
  return { mode: config.verify_tls === false ? 'none' : 'ca', fingerprint: '' };
}

function httpError(status, path, body) {
  if (status === 401)
    return new ProxmoxError(
      'auth',
      {
        en: 'PBS refused the API token (HTTP 401): check the token ID and its secret.',
        fr: "PBS a refusé le jeton API (HTTP 401) : vérifiez l'identifiant du jeton et son secret.",
      },
      { status, path },
    );
  if (status === 403)
    return new ProxmoxError(
      'permission',
      {
        en: `PBS refused access to ${path} (HTTP 403): the token is missing the DatastoreAudit or Audit role (see the documentation).`,
        fr: `PBS a refusé l'accès à ${path} (HTTP 403) : il manque au jeton le rôle DatastoreAudit ou Audit (voir la documentation).`,
      },
      { status, path },
    );
  const excerpt = String(body ?? '')
    .slice(0, 200)
    .trim();
  return new ProxmoxError(
    'http',
    {
      en: `PBS answered HTTP ${status} on ${path}. ${excerpt}`.trim(),
      fr: `PBS a répondu HTTP ${status} sur ${path}. ${excerpt}`.trim(),
    },
    { status, path },
  );
}

const DNS_ERROR_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'EAI_NODATA', 'EAI_NONAME']);
const UNREACHABLE_ERROR_CODES = new Set([
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EHOSTDOWN',
  'ENETDOWN',
]);
// Chain-of-trust failures: the fix is the same for all of them (pin the
// fingerprint, or install a certificate the container trusts).
const UNTRUSTED_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Socket-level failures, named after their fix: a host name that does not
// resolve, a port nobody listens on, and a host nothing can reach are three
// different mistakes behind the same raw `Error`.
function transportError(url, path, error) {
  if (error instanceof ProxmoxError) return error;
  const target = url.host;
  const code = error.code ?? error.message;
  if (UNTRUSTED_CERT_CODES.has(error.code))
    return new ProxmoxError(
      'tls',
      {
        en: `PBS presents a certificate this container does not trust (${code}): pin its SHA-256 fingerprint in the configuration (or turn TLS verification off on a trusted network).`,
        fr: `PBS présente un certificat auquel ce conteneur ne fait pas confiance (${code}) : épinglez son empreinte SHA-256 dans la configuration (ou désactivez la vérification TLS sur un réseau de confiance).`,
      },
      { path },
    );
  if (DNS_ERROR_CODES.has(error.code))
    return new ProxmoxError(
      'network',
      {
        en: `Cannot resolve the host name ${url.hostname} (${code}): check the server URL.`,
        fr: `Impossible de résoudre le nom d'hôte ${url.hostname} (${code}) : vérifiez l'URL du serveur.`,
      },
      { path },
    );
  if (error.code === 'ECONNREFUSED')
    return new ProxmoxError(
      'network',
      {
        en: `${target} refused the connection (ECONNREFUSED): check the port, PBS listens on 8007 by default.`,
        fr: `${target} a refusé la connexion (ECONNREFUSED) : vérifiez le port, PBS écoute sur 8007 par défaut.`,
      },
      { path },
    );
  if (UNREACHABLE_ERROR_CODES.has(error.code))
    return new ProxmoxError(
      'network',
      {
        en: `${target} is unreachable (${code}): check that the server is up and reachable from Gladys.`,
        fr: `${target} est injoignable (${code}) : vérifiez que le serveur est démarré et accessible depuis Gladys.`,
      },
      { path },
    );
  return new ProxmoxError(
    'network',
    {
      en: `Cannot reach ${target} (${code}).`,
      fr: `Impossible de joindre ${target} (${code}).`,
    },
    { path },
  );
}

function configError(en, fr) {
  return new ProxmoxError('config', { en, fr });
}

/**
 * Open the TLS connection ourselves and compare the certificate with the
 * pinned fingerprint BEFORE handing the socket to the HTTP request: the token
 * is only written once the server has proved who it is. Checking on the
 * `secureConnect` of a socket the request already owns would race with the
 * headers it has queued.
 */
function pinnedConnection(url, fingerprint, path, onSocket) {
  return (_options, callback) => {
    let done = false;
    const once = (error, socket) => {
      if (done) return;
      done = true;
      callback(error, socket);
    };
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port) || 443,
      // SNI only carries host names; Node warns when it is given an IP.
      ...(isIP(url.hostname) ? {} : { servername: url.hostname }),
      // The pinned fingerprint replaces the chain of trust: a self-signed
      // certificate is accepted only if it is exactly the expected one.
      rejectUnauthorized: false,
    });
    onSocket(socket);
    socket.once('secureConnect', () => {
      const presented = socket.getPeerCertificate()?.fingerprint256;
      if (normalizeFingerprint(presented) !== fingerprint) {
        socket.destroy();
        once(
          new ProxmoxError(
            'tls',
            {
              en: `The certificate presented by PBS does not match the pinned fingerprint (server: ${presented ?? 'none'}). The token was not sent.`,
              fr: `Le certificat présenté par PBS ne correspond pas à l'empreinte épinglée (serveur : ${presented ?? 'aucune'}). Le jeton n'a pas été envoyé.`,
            },
            { path },
          ),
        );
        return;
      }
      once(null, socket);
    });
    socket.once('error', (error) => once(error));
  };
}

export class ProxmoxClient {
  constructor(
    config,
    { timeoutMs = REQUEST_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES } = {},
  ) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  /**
   * One authenticated GET on the PBS API, resolved with its `data` member.
   * Every way it can fail ends in a `ProxmoxError`, and it always settles
   * within `timeoutMs`.
   */
  async request(path, params = {}) {
    const { base_url: baseUrl, api_token_id: tokenId, api_token_secret: secret } = this.config;
    if (!baseUrl || !tokenId || !secret)
      throw configError(
        'PBS connection is not configured: fill in the server URL, the token ID and its secret.',
        'La connexion à PBS n’est pas configurée : renseignez l’URL du serveur, l’identifiant du jeton et son secret.',
      );
    let url;
    try {
      url = new URL(`/api2/json${path}`, baseUrl);
    } catch {
      throw configError(
        `The server URL is not valid: ${baseUrl}`,
        `L'URL du serveur n'est pas valide : ${baseUrl}`,
      );
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw configError(
        'The server URL must start with https:// (or http://).',
        "L'URL du serveur doit commencer par https:// (ou http://).",
      );
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, String(value));

    const isHttps = url.protocol === 'https:';
    const tlsMode = resolveTlsMode(this.config);
    if (tlsMode.mode === 'fingerprint') {
      // Pinning over plain HTTP would look safe while sending the token in clear.
      if (!isHttps)
        throw configError(
          'A certificate fingerprint is pinned but the server URL uses http://: use https://.',
          "Une empreinte de certificat est épinglée mais l'URL du serveur utilise http:// : utilisez https://.",
        );
      if (tlsMode.fingerprint.length !== 64)
        throw configError(
          'The certificate fingerprint must be a SHA-256 fingerprint (64 hexadecimal characters).',
          "L'empreinte du certificat doit être une empreinte SHA-256 (64 caractères hexadécimaux).",
        );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let pendingSocket;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          request?.destroy();
          pendingSocket?.destroy();
        } else resolve(value);
      };
      const timer = setTimeout(
        () =>
          finish(
            new ProxmoxError(
              'timeout',
              {
                en: `PBS did not answer ${path} within ${this.timeoutMs / 1000} s.`,
                fr: `PBS n'a pas répondu à ${path} en moins de ${this.timeoutMs / 1000} s.`,
              },
              { path },
            ),
          ),
        this.timeoutMs,
      );
      const cut = () =>
        new ProxmoxError(
          'network',
          {
            en: `The PBS answer on ${path} was interrupted.`,
            fr: `La réponse de PBS sur ${path} a été interrompue.`,
          },
          { path },
        );

      const options = {
        method: 'GET',
        headers: {
          Authorization: `PBSAPIToken=${this.config.api_token_id}:${this.config.api_token_secret}`,
          Accept: 'application/json',
        },
      };
      if (tlsMode.mode === 'fingerprint')
        options.createConnection = pinnedConnection(url, tlsMode.fingerprint, path, (socket) => {
          pendingSocket = socket;
        });
      else {
        // No pooled socket: a refresh every few minutes gains nothing from
        // keep-alive, and a fresh handshake is checked every time.
        options.agent = false;
        if (isHttps) options.rejectUnauthorized = tlsMode.mode === 'ca';
      }

      try {
        request = (isHttps ? https : http).request(url, options, (response) => {
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > this.maxResponseBytes) {
              finish(
                new ProxmoxError(
                  'http',
                  {
                    en: `The PBS answer on ${path} exceeded ${this.maxResponseBytes / 1024 / 1024} MB.`,
                    fr: `La réponse de PBS sur ${path} dépasse ${this.maxResponseBytes / 1024 / 1024} Mo.`,
                  },
                  { path },
                ),
              );
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => finish(cut()));
          response.on('close', () => {
            if (!response.complete) finish(cut());
          });
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) return finish(httpError(status, path, body));
            try {
              finish(null, JSON.parse(body).data);
            } catch {
              finish(
                new ProxmoxError(
                  'parse',
                  {
                    en: `The PBS answer on ${path} is not valid JSON.`,
                    fr: `La réponse de PBS sur ${path} n'est pas du JSON valide.`,
                  },
                  { status, path },
                ),
              );
            }
          });
        });
      } catch (error) {
        finish(transportError(url, path, error));
        return;
      }
      request.on('error', (error) => finish(transportError(url, path, error)));
      request.end();
    });
  }

  getDatastores() {
    return this.request('/status/datastore-usage');
  }
  // Backup groups carry `backup-count` and `last-backup`, which is everything
  // the integration needs; listing every snapshot would download megabytes of
  // JSON on a large datastore just to count entries.
  getGroups(store) {
    return this.request(`/admin/datastore/${encodeURIComponent(store)}/groups`);
  }
  getSnapshots(store) {
    return this.request(`/admin/datastore/${encodeURIComponent(store)}/snapshots`);
  }
  getTasks(store, { start = 0, limit = TASK_PAGE_SIZE, typefilter } = {}) {
    return this.request(`/nodes/${encodeURIComponent(this.config.node)}/tasks`, {
      store,
      start,
      limit,
      typefilter,
    });
  }
}

function workerType(task) {
  return String(task.worker_type ?? task.worker_type_name ?? '').toLowerCase();
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function hasTaskOfType(tasks, type) {
  return tasks.some((task) => TASK_TYPE_ALIASES[type].includes(workerType(task)));
}

// `typefilter` keeps the tasks whose worker type CONTAINS the given text (PBS
// `list_tasks`), so one short filtered read per type finds the newest run even
// when thousands of backups ran since, and costs nothing when a type never ran.
// PBS worker types: verify, verify_group, verify_snapshot, verificationjob,
// garbage_collection, prune, prunejob.
export const TASK_TYPE_FILTERS = { verify: 'verif', gc: 'garbage', prune: 'prune' };
export const TYPED_TASK_LIMIT = 50;

// Servers that refused `typefilter` (HTTP 400, the PBS parameter check): they
// are paged from then on instead of failing every refresh.
const typeFilterUnsupported = new Set();

/** Forget which servers refused `typefilter` (tests). */
export function resetTypeFilterSupport() {
  typeFilterUnsupported.clear();
}

/**
 * Page through the unfiltered task history until the newest task of every
 * requested type has been seen (or the page budget runs out). Only used when
 * the server does not support `typefilter`.
 */
export async function pageTasks(client, store, types = Object.keys(TASK_TYPE_ALIASES)) {
  const tasks = [];
  for (let page = 0; page < TASK_MAX_PAGES; page += 1) {
    const batch = await client.getTasks(store, {
      start: page * TASK_PAGE_SIZE,
      limit: TASK_PAGE_SIZE,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    tasks.push(...batch);
    if (types.every((type) => hasTaskOfType(tasks, type))) break;
    if (batch.length < TASK_PAGE_SIZE) break;
  }
  return tasks;
}

/**
 * The recent tasks of every requested type for one datastore: one filtered
 * read per type, or the paged history on a server that refuses the filter.
 */
export async function fetchTasks(
  client,
  store,
  types = Object.keys(TASK_TYPE_ALIASES),
  log = logger,
) {
  const serverKey = client.config?.base_url ?? '';
  if (!typeFilterUnsupported.has(serverKey)) {
    try {
      const batches = await Promise.all(
        types.map((type) =>
          client.getTasks(store, {
            start: 0,
            limit: TYPED_TASK_LIMIT,
            typefilter: TASK_TYPE_FILTERS[type],
          }),
        ),
      );
      return batches.flatMap((batch) => (Array.isArray(batch) ? batch : []));
    } catch (error) {
      if (error?.status !== 400) throw error;
      typeFilterUnsupported.add(serverKey);
      log.warn(
        `PBS refused the task type filter, paging the task history instead: ${error.message}`,
      );
    }
  }
  return pageTasks(client, store, types);
}

const zoneFormatters = new Map();

/**
 * Wall-clock fields of `date` in `timeZone`, plus the zone offset in minutes.
 * One `Intl.DateTimeFormat` per zone is cached: a refresh formats a handful of
 * dates for every datastore, forever.
 */
function zonedFields(date, timeZone) {
  if (!zoneFormatters.has(timeZone)) {
    zoneFormatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  }
  const parts = Object.fromEntries(
    zoneFormatters
      .get(timeZone)
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );
  const wallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offsetMinutes = Math.round((wallClock - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  return { ...parts, offsetMinutes };
}

export function formatTaskDate(epoch, format = 'iso', timeZone = 'UTC') {
  const date = new Date(Number(epoch) * 1000);
  const isIso = format.toLowerCase() === 'iso';
  if (isIso && timeZone === 'UTC') return date.toISOString();
  const pad = (value) => String(value).padStart(2, '0');
  const fields = zonedFields(date, timeZone);
  const tokens = {
    YYYY: fields.year,
    MM: pad(fields.month),
    DD: pad(fields.day),
    HH: pad(fields.hour),
    mm: pad(fields.minute),
    ss: pad(fields.second),
  };
  if (!isIso) return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token]);
  const sign = fields.offsetMinutes < 0 ? '-' : '+';
  const offset = Math.abs(fields.offsetMinutes);
  return `${tokens.YYYY}-${tokens.MM}-${tokens.DD}T${tokens.HH}:${tokens.mm}:${tokens.ss}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

/**
 * Outcome of a PBS task, reduced to what a dashboard or a scene can act on.
 * PBS reports `OK`, `WARNINGS: n`, or the error text itself; a task without
 * an end time is still running.
 */
export function taskResult(task) {
  if (!task) return 'never';
  if (task.status === undefined || task.status === null) return task.endtime ? 'ok' : 'running';
  const status = String(task.status);
  if (status === 'OK') return 'ok';
  if (/^warnings?\b/i.test(status)) return 'warning';
  return 'error';
}

export function taskDetails(tasks, type, dateFormat = 'iso', timeZone = 'UTC') {
  const task = tasks
    .filter((item) => TASK_TYPE_ALIASES[type].includes(workerType(item)))
    .sort(
      (a, b) => Number(b.endtime ?? b.starttime ?? 0) - Number(a.endtime ?? a.starttime ?? 0),
    )[0];
  if (!task) {
    return { status: 'Never run', date: 'Never run', result: 'never', id: null, epoch: null };
  }
  const status = task.status ?? (task.endtime ? 'OK' : 'running');
  const epoch = Number(task.endtime ?? task.starttime);
  const date = formatTaskDate(epoch, dateFormat, timeZone);
  // The UPID identifies one run; it is what tells a new task from the one
  // already reported when the scene triggers compare two refreshes.
  const id = String(task.upid ?? `${workerType(task)}:${task.starttime ?? task.endtime}`);
  // The raw epoch lets a widget hand Gladys an ISO date it formats itself.
  return { status, date, result: taskResult(task), id, epoch };
}

export function newestBackupEpoch(entries) {
  return entries.reduce(
    (latest, item) =>
      Math.max(
        latest,
        toFiniteNumber(item['last-backup'] ?? item['backup-time'] ?? item.backup_time),
      ),
    0,
  );
}

export function countBackups(groups) {
  return groups.reduce(
    (total, group) => total + toFiniteNumber(group['backup-count'] ?? group.backup_count),
    0,
  );
}

/**
 * Snapshot count and freshness for a datastore, read from the cheap `groups`
 * route when PBS exposes the counters, falling back to the full snapshot list.
 */
export async function readInventory(client, store, log = logger) {
  let reason;
  try {
    const groups = await client.getGroups(store);
    if (
      Array.isArray(groups) &&
      groups.every((group) => Number.isFinite(Number(group['backup-count'] ?? group.backup_count)))
    )
      return {
        snapshotCount: countBackups(groups),
        newestBackupEpoch: newestBackupEpoch(groups),
        source: 'groups',
      };
    reason = 'the groups route does not expose backup-count';
  } catch (error) {
    // Only a route this PBS does not serve (404) or does not accept (400)
    // justifies the much more expensive snapshot list. A timeout, a cut
    // connection or a refused token would fail the same way there, after
    // downloading far more.
    if (error?.status !== 400 && error?.status !== 404) throw error;
    reason = error.message;
  }
  // Logged so a silent (and much more expensive) fallback is visible in the
  // container logs instead of only showing up as slow refreshes.
  log.warn(`Falling back to the snapshot list for datastore ${store}: ${reason}`);
  const snapshots = await client.getSnapshots(store);
  const list = Array.isArray(snapshots) ? snapshots : [];
  return {
    snapshotCount: list.length,
    newestBackupEpoch: newestBackupEpoch(list),
    source: 'snapshots',
  };
}
