import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { newestSnapshotEpoch, ProxmoxClient, taskSummary } from './proxmox.js';

const STALE_AFTER_SECONDS = 26 * 60 * 60;
export const GLADYS_POLL_FREQUENCY_MS = 60 * 1000;
const CAT = DEVICE_FEATURE_CATEGORIES;
const TYPE = DEVICE_FEATURE_TYPES;
const UNIT = DEVICE_FEATURE_UNITS;

function feature(ids, key, name, category, type, unit, history = true) {
  return {
    name,
    external_id: ids.feature(key),
    category,
    type,
    unit,
    min: 0,
    max: 1e15,
    read_only: true,
    has_feedback: false,
    keep_history: history,
  };
}

export function isPollDue(lastPollAt, intervalSeconds, now = Date.now()) {
  return lastPollAt === undefined || now - lastPollAt >= intervalSeconds * 1000;
}

export function buildDatastoreDevice(gladys, store) {
  const ids = gladys.externalIds('pbs-datastore', store.store);
  return {
    name: `PBS — ${store.store}`,
    external_id: ids.device,
    should_poll: true,
    poll_frequency: GLADYS_POLL_FREQUENCY_MS,
    features: [
      feature(ids, 'usage', 'Usage', CAT.ENERGY_SENSOR, TYPE.SENSOR.DECIMAL, UNIT.PERCENT),
      feature(ids, 'total', 'Total size', CAT.ENERGY_SENSOR, TYPE.SENSOR.DECIMAL, UNIT.GIGABYTE),
      feature(ids, 'used', 'Used space', CAT.ENERGY_SENSOR, TYPE.SENSOR.DECIMAL, UNIT.GIGABYTE),
      feature(
        ids,
        'snapshots',
        'Snapshot count',
        CAT.MAINTENANCE,
        TYPE.SENSOR.INTEGER,
        UNIT.UNKNOWN,
      ),
      feature(ids, 'last-verify', 'Last verify', CAT.TEXT, TYPE.TEXT.TEXT, UNIT.UNKNOWN, false),
      feature(
        ids,
        'last-gc',
        'Last garbage collection',
        CAT.TEXT,
        TYPE.TEXT.TEXT,
        UNIT.UNKNOWN,
        false,
      ),
      feature(ids, 'last-prune', 'Last prune', CAT.TEXT, TYPE.TEXT.TEXT, UNIT.UNKNOWN, false),
      {
        ...feature(
          ids,
          'backup-stale',
          'Backup stale (> 26 h)',
          CAT.MAINTENANCE,
          'binary',
          UNIT.UNKNOWN,
        ),
        max: 1,
      },
    ],
  };
}

export async function readDatastore(gladys, storeName, config, now = Date.now()) {
  const client = new ProxmoxClient(config);
  const [stores, snapshots, tasks] = await Promise.all([
    client.getDatastores(),
    client.getSnapshots(storeName),
    client.getTasks(storeName),
  ]);
  const store = stores.find((item) => item.store === storeName);
  if (!store) throw new Error(`Datastore ${storeName} no longer exists`);
  const ids = gladys.externalIds('pbs-datastore', storeName);
  const latest = newestSnapshotEpoch(snapshots);
  const stale = !latest || now / 1000 - latest > STALE_AFTER_SECONDS;
  return [
    {
      device_feature_external_id: ids.feature('usage'),
      state: store.total ? (Number(store.used) / Number(store.total)) * 100 : 0,
    },
    { device_feature_external_id: ids.feature('total'), state: Number(store.total) / 1e9 },
    { device_feature_external_id: ids.feature('used'), state: Number(store.used) / 1e9 },
    { device_feature_external_id: ids.feature('snapshots'), state: snapshots.length },
    { device_feature_external_id: ids.feature('last-verify'), state: taskSummary(tasks, 'verify') },
    { device_feature_external_id: ids.feature('last-gc'), state: taskSummary(tasks, 'gc') },
    { device_feature_external_id: ids.feature('last-prune'), state: taskSummary(tasks, 'prune') },
    { device_feature_external_id: ids.feature('backup-stale'), state: stale ? 1 : 0 },
  ];
}
