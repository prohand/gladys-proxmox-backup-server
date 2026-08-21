#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Diagnostic against a real Proxmox Backup Server: which inventory route the
// integration actually uses, and whether both agree.
//
//   PBS_URL=https://pbs.example.com:8007 \
//   PBS_TOKEN_ID='gladys@pbs!monitoring' \
//   PBS_TOKEN_SECRET='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' \
//   npm run check:pbs
//
// Optional: PBS_NODE (default localhost), PBS_VERIFY_TLS=false for a
// self-signed certificate. Read-only: only GET routes are called.
// -----------------------------------------------------------------------------
import { normalizeConfig } from '../src/config.js';
import { fetchTasks, ProxmoxClient, readInventory, taskDetails } from '../src/proxmox.js';

const config = normalizeConfig({
  base_url: process.env.PBS_URL,
  api_token_id: process.env.PBS_TOKEN_ID,
  api_token_secret: process.env.PBS_TOKEN_SECRET,
  node: process.env.PBS_NODE,
  verify_tls: process.env.PBS_VERIFY_TLS !== 'false',
});

if (!config.base_url || !config.api_token_id || !config.api_token_secret) {
  console.error('Set PBS_URL, PBS_TOKEN_ID and PBS_TOKEN_SECRET first.');
  process.exit(2);
}

const log = { warn: (message) => console.log(`  fallback: ${message}`) };
const client = new ProxmoxClient(config);
const timed = async (label, run) => {
  const startedAt = Date.now();
  const value = await run();
  console.log(`  ${label}: ${Date.now() - startedAt} ms`);
  return value;
};

const stores = await client.getDatastores();
console.log(`Connected to ${config.base_url} — ${stores.length} datastore(s)\n`);

let mismatch = false;
for (const { store } of stores) {
  console.log(`Datastore ${store}`);
  const inventory = await timed('inventory', () => readInventory(client, store, log));
  console.log(
    `  route used: ${inventory.source} (${inventory.snapshotCount} snapshot(s), newest ${
      inventory.newestBackupEpoch
        ? new Date(inventory.newestBackupEpoch * 1000).toISOString()
        : 'none'
    })`,
  );

  // Cross-check against the route the integration deliberately avoids: both
  // must report the same inventory, otherwise the cheap route is lying.
  const snapshots = await timed('snapshot list (reference)', () => client.getSnapshots(store));
  const reference = {
    snapshotCount: snapshots.length,
    newestBackupEpoch: snapshots.reduce(
      (latest, item) => Math.max(latest, Number(item['backup-time'] ?? 0)),
      0,
    ),
  };
  const agrees =
    reference.snapshotCount === inventory.snapshotCount &&
    reference.newestBackupEpoch === inventory.newestBackupEpoch;
  if (!agrees) {
    mismatch = true;
    console.log(
      `  MISMATCH: snapshot list reports ${reference.snapshotCount} snapshot(s), newest epoch ${reference.newestBackupEpoch}`,
    );
  } else {
    console.log('  both routes agree');
  }

  const tasks = await timed('task history', () => fetchTasks(client, store));
  for (const type of ['verify', 'gc', 'prune']) {
    const { status, date } = taskDetails(tasks, type, config.date_format);
    console.log(`  last ${type}: ${status} — ${date}`);
  }
  console.log('');
}

process.exit(mismatch ? 1 : 0);
