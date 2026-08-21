import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchTasks, ProxmoxClient, readInventory, taskDetails } from './proxmox.js';

const STALE_AFTER_SECONDS = 26 * 60 * 60;
export const GLADYS_POLL_FREQUENCY_MS = 60 * 1000;
const MAX_NUMERIC_STATE = 1e15;
const CAT = DEVICE_FEATURE_CATEGORIES;
const TYPE = DEVICE_FEATURE_TYPES;
const UNIT = DEVICE_FEATURE_UNITS;

function roundToTwo(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

// `min`/`max` only describe numeric features; text features carry no range.
function numericFeature(ids, key, name, category, type, unit, { history = true, max } = {}) {
  return {
    name,
    external_id: ids.feature(key),
    category,
    type,
    unit,
    min: 0,
    max: max ?? MAX_NUMERIC_STATE,
    read_only: true,
    has_feedback: false,
    keep_history: history,
  };
}

function textFeature(ids, key, name) {
  return {
    name,
    external_id: ids.feature(key),
    category: CAT.TEXT,
    type: TYPE.TEXT.TEXT,
    unit: UNIT.UNKNOWN,
    read_only: true,
    has_feedback: false,
    keep_history: false,
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
      numericFeature(ids, 'usage', 'Usage', CAT.DATA, TYPE.DATA.SIZE, UNIT.PERCENT),
      numericFeature(ids, 'total', 'Total size', CAT.DATA, TYPE.DATA.SIZE, UNIT.GIGABYTE),
      numericFeature(ids, 'used', 'Used space', CAT.DATA, TYPE.DATA.SIZE, UNIT.GIGABYTE),
      numericFeature(
        ids,
        'snapshots',
        'Snapshot count',
        CAT.COUNTER_SENSOR,
        TYPE.SENSOR.INTEGER,
        UNIT.UNKNOWN,
      ),
      textFeature(ids, 'last-verify', 'Last verify status'),
      textFeature(ids, 'last-verify-date', 'Last verify date'),
      textFeature(ids, 'last-gc', 'Last garbage collection status'),
      textFeature(ids, 'last-gc-date', 'Last garbage collection date'),
      textFeature(ids, 'last-prune', 'Last prune status'),
      textFeature(ids, 'last-prune-date', 'Last prune date'),
      numericFeature(
        ids,
        'backup-stale',
        'Backup stale (> 26 h)',
        CAT.RISK,
        TYPE.RISK.INTEGER,
        UNIT.UNKNOWN,
        { max: 1 },
      ),
    ],
  };
}

export function buildDatastoreStates(
  gladys,
  store,
  inventory,
  tasks,
  now = Date.now(),
  dateFormat = 'iso',
) {
  const ids = gladys.externalIds('pbs-datastore', store.store);
  const latest = Number(inventory.newestBackupEpoch);
  const stale = !latest || now / 1000 - latest > STALE_AFTER_SECONDS;
  const verify = taskDetails(tasks, 'verify', dateFormat);
  const garbageCollection = taskDetails(tasks, 'gc', dateFormat);
  const prune = taskDetails(tasks, 'prune', dateFormat);
  // A datastore that is offline or unmounted reports no capacity at all; keep
  // publishing 0 instead of NaN so the Gladys history stays usable.
  const total = Number(store.total);
  const used = Number(store.used);
  const hasCapacity = Number.isFinite(total) && Number.isFinite(used) && total > 0;
  return [
    {
      device_feature_external_id: ids.feature('usage'),
      state: hasCapacity ? roundToTwo((used / total) * 100) : 0,
    },
    { device_feature_external_id: ids.feature('total'), state: roundToTwo(total / 1e9) },
    { device_feature_external_id: ids.feature('used'), state: roundToTwo(used / 1e9) },
    {
      device_feature_external_id: ids.feature('snapshots'),
      state: roundToTwo(inventory.snapshotCount),
    },
    { device_feature_external_id: ids.feature('last-verify'), text: verify.status },
    { device_feature_external_id: ids.feature('last-verify-date'), text: verify.date },
    { device_feature_external_id: ids.feature('last-gc'), text: garbageCollection.status },
    { device_feature_external_id: ids.feature('last-gc-date'), text: garbageCollection.date },
    { device_feature_external_id: ids.feature('last-prune'), text: prune.status },
    { device_feature_external_id: ids.feature('last-prune-date'), text: prune.date },
    { device_feature_external_id: ids.feature('backup-stale'), state: stale ? 1 : 0 },
  ];
}

export async function readDatastore(gladys, storeName, config, now = Date.now()) {
  const client = new ProxmoxClient(config);
  const [stores, inventory, tasks] = await Promise.all([
    client.getDatastores(),
    readInventory(client, storeName),
    fetchTasks(client, storeName),
  ]);
  const store = stores.find((item) => item.store === storeName);
  if (!store) throw new Error(`Datastore ${storeName} no longer exists`);
  return buildDatastoreStates(gladys, store, inventory, tasks, now, config.date_format);
}
