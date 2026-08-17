import http from 'node:http';
import https from 'node:https';

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
  getSnapshots(store) {
    return this.request(`/admin/datastore/${encodeURIComponent(store)}/snapshots`);
  }
  getTasks(store) {
    return this.request(`/nodes/${encodeURIComponent(this.config.node)}/tasks`, {
      store,
      limit: 500,
    });
  }
}

export function taskSummary(tasks, type) {
  const aliases = {
    verify: ['verify', 'verifyjob', 'verifysnapshot'],
    gc: ['garbage_collection', 'garbage-collection', 'gc'],
    prune: ['prune', 'prunejob'],
  };
  const task = tasks
    .filter((item) =>
      aliases[type].includes(String(item.worker_type ?? item.worker_type_name ?? '').toLowerCase()),
    )
    .sort(
      (a, b) => Number(b.endtime ?? b.starttime ?? 0) - Number(a.endtime ?? a.starttime ?? 0),
    )[0];
  if (!task) return 'Never run';
  const status = task.status ?? (task.endtime ? 'OK' : 'running');
  const time = new Date(Number(task.endtime ?? task.starttime) * 1000).toISOString();
  return `${status} — ${time}`;
}

export function newestSnapshotEpoch(snapshots) {
  return snapshots.reduce(
    (latest, item) => Math.max(latest, Number(item['backup-time'] ?? item.backup_time ?? 0)),
    0,
  );
}
