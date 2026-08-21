import http from 'node:http';
import https from 'node:https';
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

export class ProxmoxClient {
  constructor(config) {
    this.config = config;
  }

  async request(path, params = {}) {
    if (!this.config.base_url || !this.config.api_token_id || !this.config.api_token_secret)
      throw new Error('PBS connection is not configured');
    const url = new URL(`/api2/json${path}`, this.config.base_url);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.get(
        url,
        {
          headers: {
            Authorization: `PBSAPIToken=${this.config.api_token_id}:${this.config.api_token_secret}`,
          },
          rejectUnauthorized: this.config.verify_tls,
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300)
              return reject(
                new Error(`PBS API returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`),
              );
            try {
              resolve(JSON.parse(body).data);
            } catch {
              reject(new Error('PBS API returned invalid JSON'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('PBS API request timed out')));
      req.on('error', reject);
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
  getTasks(store, { start = 0, limit = TASK_PAGE_SIZE } = {}) {
    return this.request(`/nodes/${encodeURIComponent(this.config.node)}/tasks`, {
      store,
      start,
      limit,
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

/**
 * Page through the task history until the newest task of every requested type
 * has been seen (or the page budget runs out).
 */
export async function fetchTasks(client, store, types = Object.keys(TASK_TYPE_ALIASES)) {
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

export function formatTaskDate(epoch, format = 'iso') {
  const date = new Date(Number(epoch) * 1000);
  if (format.toLowerCase() === 'iso') return date.toISOString();
  const pad = (value) => String(value).padStart(2, '0');
  const tokens = {
    YYYY: date.getUTCFullYear(),
    MM: pad(date.getUTCMonth() + 1),
    DD: pad(date.getUTCDate()),
    HH: pad(date.getUTCHours()),
    mm: pad(date.getUTCMinutes()),
    ss: pad(date.getUTCSeconds()),
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token]);
}

export function taskDetails(tasks, type, dateFormat = 'iso') {
  const task = tasks
    .filter((item) => TASK_TYPE_ALIASES[type].includes(workerType(item)))
    .sort(
      (a, b) => Number(b.endtime ?? b.starttime ?? 0) - Number(a.endtime ?? a.starttime ?? 0),
    )[0];
  if (!task) return { status: 'Never run', date: 'Never run' };
  const status = task.status ?? (task.endtime ? 'OK' : 'running');
  const date = formatTaskDate(task.endtime ?? task.starttime, dateFormat);
  return { status, date };
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
    // Older PBS releases (or a restricted ACL) may not serve `groups`: fall
    // back to the snapshot list below rather than failing the whole poll.
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
