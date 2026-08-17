import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDatastoreDevice, GLADYS_POLL_FREQUENCY_MS, isPollDue } from '../src/datastores.js';

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
});

test('custom polling interval throttles Gladys one-minute poll events', () => {
  assert.equal(isPollDue(undefined, 300, 1_000), true);
  assert.equal(isPollDue(1_000, 300, 300_999), false);
  assert.equal(isPollDue(1_000, 300, 301_000), true);
});
