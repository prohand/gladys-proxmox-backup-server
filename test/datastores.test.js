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
});

test('custom polling interval throttles Gladys one-minute poll events', () => {
  assert.equal(isPollDue(undefined, 300, 1_000), true);
  assert.equal(isPollDue(1_000, 300, 300_999), false);
  assert.equal(isPollDue(1_000, 300, 301_000), true);
});

test('datastore states use the text field for maintenance summaries', () => {
  const states = buildDatastoreStates(
    gladys,
    { store: 'backup', total: 100, used: 25 },
    [],
    [],
    1_000,
  );
  for (const key of ['last-verify', 'last-gc', 'last-prune']) {
    assert.deepEqual(
      states.find((state) => state.device_feature_external_id.endsWith(`:${key}`)),
      {
        device_feature_external_id: `ext:test:pbs-datastore:backup:${key}`,
        text: 'Never run',
      },
    );
  }
  assert.equal(
    states.find((state) => state.device_feature_external_id.endsWith(':backup-stale')).state,
    1,
  );
});
