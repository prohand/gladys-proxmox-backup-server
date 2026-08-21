import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDatastoreDevice,
  buildDatastoreStates,
  GLADYS_POLL_FREQUENCY_MS,
  isPollDue,
} from '../src/datastores.js';

const gladys = {
  externalIds(type, id) {
    const device = `ext:test:${type}:${id}`;
    return { device, feature: (key) => `${device}:${key}` };
  },
};

test('datastore devices use the valid Gladys one-minute polling frequency', () => {
  const device = buildDatastoreDevice(gladys, { store: 'backup' });
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, 60_000);
  assert.equal(device.poll_frequency, GLADYS_POLL_FREQUENCY_MS);

  const snapshotCount = device.features.find((feature) =>
    feature.external_id.endsWith(':snapshots'),
  );
  const capacityFeatures = ['usage', 'total', 'used'].map((key) =>
    device.features.find((feature) => feature.external_id.endsWith(`:${key}`)),
  );
  const backupStale = device.features.find((feature) =>
    feature.external_id.endsWith(':backup-stale'),
  );
  assert.deepEqual(
    { category: snapshotCount.category, type: snapshotCount.type },
    { category: 'counter-sensor', type: 'integer' },
  );
  assert.deepEqual(
    { category: backupStale.category, type: backupStale.type },
    { category: 'risk', type: 'integer' },
  );
  assert.deepEqual(
    capacityFeatures.map(({ category, type, unit }) => ({ category, type, unit })),
    [
      { category: 'data', type: 'size', unit: 'percent' },
      { category: 'data', type: 'size', unit: 'gigabyte' },
      { category: 'data', type: 'size', unit: 'gigabyte' },
    ],
  );
  assert.ok(device.features.some((feature) => feature.external_id.endsWith(':last-gc-date')));
  assert.ok(device.features.some((feature) => feature.external_id.endsWith(':last-prune-date')));
  assert.ok(device.features.some((feature) => feature.external_id.endsWith(':last-verify-date')));
});

test('custom polling interval throttles Gladys one-minute poll events', () => {
  assert.equal(isPollDue(undefined, 300, 1_000), true);
  assert.equal(isPollDue(1_000, 300, 300_999), false);
  assert.equal(isPollDue(1_000, 300, 301_000), true);
});

test('datastore states split task statuses and dates and round capacity values', () => {
  const states = buildDatastoreStates(
    gladys,
    { store: 'backup', total: 2875.829006336e9, used: 1854.120583168e9 },
    { snapshotCount: 12, newestBackupEpoch: 0 },
    [
      { worker_type: 'verificationjob', status: 'OK', endtime: 10 },
      { worker_type: 'garbage_collection', status: 'OK', endtime: 20 },
      { worker_type: 'prune', status: 'OK', endtime: 30 },
    ],
    1_000,
    'DD/MM/YYYY HH:mm:ss',
  );
  const state = (key) => states.find((item) => item.device_feature_external_id.endsWith(`:${key}`));
  assert.equal(state('usage').state, 64.47);
  assert.equal(state('total').state, 2875.83);
  assert.equal(state('used').state, 1854.12);
  assert.equal(state('snapshots').state, 12);
  assert.equal(state('last-verify').text, 'OK');
  assert.equal(state('last-verify-date').text, '01/01/1970 00:00:10');
  assert.equal(state('last-gc').text, 'OK');
  assert.equal(state('last-gc-date').text, '01/01/1970 00:00:20');
  assert.equal(state('last-prune').text, 'OK');
  assert.equal(state('last-prune-date').text, '01/01/1970 00:00:30');
  assert.equal(
    states.find((state) => state.device_feature_external_id.endsWith(':backup-stale')).state,
    1,
  );
});

test('every feature carries a numeric range, text ones included', () => {
  const device = buildDatastoreDevice(gladys, { store: 'backup' });
  const feature = (key) => device.features.find((item) => item.external_id.endsWith(`:${key}`));

  // Gladys stores min/max as NOT NULL columns and compares them to detect a
  // structure change: a feature published without them is never in sync.
  for (const item of device.features) {
    assert.equal(typeof item.min, 'number');
    assert.equal(typeof item.max, 'number');
  }
  for (const key of ['last-verify', 'last-verify-date', 'last-gc', 'last-gc-date', 'last-prune']) {
    assert.deepEqual({ min: feature(key).min, max: feature(key).max }, { min: 0, max: 1e15 });
    assert.equal(feature(key).keep_history, false);
  }
  assert.deepEqual({ min: feature('usage').min, max: feature('usage').max }, { min: 0, max: 1e15 });
  assert.deepEqual(
    { min: feature('backup-stale').min, max: feature('backup-stale').max },
    { min: 0, max: 1 },
  );
});

test('an offline datastore publishes zeros instead of NaN', () => {
  const states = buildDatastoreStates(
    gladys,
    { store: 'offline' },
    { snapshotCount: 0, newestBackupEpoch: 0 },
    [],
    1_000,
  );
  const state = (key) => states.find((item) => item.device_feature_external_id.endsWith(`:${key}`));
  assert.deepEqual(
    ['usage', 'total', 'used', 'snapshots'].map((key) => state(key).state),
    [0, 0, 0, 0],
  );
  assert.equal(state('backup-stale').state, 1);
});

test('a fresh backup clears the stale sensor', () => {
  const now = 1_000_000_000_000;
  const states = buildDatastoreStates(
    gladys,
    { store: 'backup', total: 1e9, used: 5e8 },
    { snapshotCount: 3, newestBackupEpoch: now / 1000 - 3600 },
    [],
    now,
  );
  const state = (key) => states.find((item) => item.device_feature_external_id.endsWith(`:${key}`));
  assert.equal(state('backup-stale').state, 0);
  assert.equal(state('usage').state, 50);
});
