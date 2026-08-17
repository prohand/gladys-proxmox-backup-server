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
    [],
    [
      { worker_type: 'garbage_collection', status: 'OK', endtime: 20 },
      { worker_type: 'prune', status: 'OK', endtime: 30 },
    ],
    1_000,
  );
  const state = (key) => states.find((item) => item.device_feature_external_id.endsWith(`:${key}`));
  assert.equal(state('usage').state, 64.47);
  assert.equal(state('total').state, 2875.83);
  assert.equal(state('used').state, 1854.12);
  assert.equal(state('last-verify').text, 'Never run');
  assert.equal(state('last-gc').text, 'OK');
  assert.equal(state('last-gc-date').text, '1970-01-01T00:00:20.000Z');
  assert.equal(state('last-prune').text, 'OK');
  assert.equal(state('last-prune-date').text, '1970-01-01T00:00:30.000Z');
  assert.equal(
    states.find((state) => state.device_feature_external_id.endsWith(':backup-stale')).state,
    1,
  );
});
