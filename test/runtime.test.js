import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime, registerRuntime } from '../src/runtime.js';

function fakeGladys(config = {}) {
  const calls = { discovered: [], states: [], connectionStatus: [] };
  return {
    calls,
    externalIds(type, id) {
      const device = `ext:test:${type}:${id}`;
      return { device, feature: (key) => `${device}:${key}` };
    },
    getConfig: () => Promise.resolve(config),
    publishDiscoveredDevices(devices) {
      calls.discovered.push(devices);
      return Promise.resolve();
    },
    publishStates(states) {
      calls.states.push(states);
      return Promise.resolve();
    },
    setConnectionStatus(connected, message) {
      calls.connectionStatus.push({ connected, message });
      return Promise.resolve();
    },
  };
}

const CONFIG = { base_url: 'https://pbs:8007', poll_frequency: 900 };

test('discover publishes one device per datastore', async () => {
  const gladys = fakeGladys(CONFIG);
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }, { store: 'two' }]),
  });

  assert.equal(await runtime.discover(), 2);
  assert.deepEqual(
    gladys.calls.discovered[0].map(({ external_id: id }) => id),
    ['ext:test:pbs-datastore:one', 'ext:test:pbs-datastore:two'],
  );
});

test('poll throttles Gladys one-minute events down to the refresh interval', async () => {
  const gladys = fakeGladys(CONFIG);
  let clock = 1_000_000;
  let reads = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readStates: () => {
      reads += 1;
      return Promise.resolve([{ device_feature_external_id: 'f', state: reads }]);
    },
    now: () => clock,
  });
  await runtime.updateConfig({ ...CONFIG, poll_frequency: 900 });
  const device = { external_id: 'ext:test:pbs-datastore:one' };

  await runtime.poll(device);
  await runtime.poll(device);
  assert.equal(reads, 1);

  clock += 899_000;
  await runtime.poll(device);
  assert.equal(reads, 1);

  clock += 1_000;
  await runtime.poll(device);
  assert.equal(reads, 2);
  assert.equal(gladys.calls.states.length, 2);
});

test('poll re-discovers an unknown device before giving up', async () => {
  const gladys = fakeGladys(CONFIG);
  let discoveries = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => {
      discoveries += 1;
      return Promise.resolve([{ store: 'one' }]);
    },
    readStates: () => Promise.resolve([]),
  });

  await runtime.poll({ external_id: 'ext:test:pbs-datastore:one' });
  assert.equal(discoveries, 1);
  assert.equal(gladys.calls.states.length, 1);

  await runtime.poll({ external_id: 'ext:test:pbs-datastore:unknown' });
  assert.equal(discoveries, 2);
  assert.equal(gladys.calls.states.length, 1);
});

test('a failed poll retries on the next tick instead of waiting a full interval', async () => {
  const gladys = fakeGladys(CONFIG);
  let attempts = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readStates: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('PBS API request timed out'));
      return Promise.resolve([]);
    },
    now: () => 1_000_000,
  });
  const device = { external_id: 'ext:test:pbs-datastore:one' };

  await assert.rejects(runtime.poll(device), /timed out/);
  await runtime.poll(device);
  assert.equal(attempts, 2);
});

test('a changed config is normalized and clears the throttling state', async () => {
  const gladys = fakeGladys(CONFIG);
  let clock = 0;
  let reads = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readStates: () => {
      reads += 1;
      return Promise.resolve([]);
    },
    now: () => clock,
  });
  const device = { external_id: 'ext:test:pbs-datastore:one' };

  await runtime.poll(device);
  clock += 1_000;
  await runtime.updateConfig({ ...CONFIG, poll_frequency: 10, verify_tls: false });
  assert.equal(runtime.getConfig().poll_frequency, 300);
  assert.equal(runtime.getConfig().verify_tls, false);

  await runtime.poll(device);
  assert.equal(reads, 2);
});

test('start retries with a backoff before reporting a failed connection', async () => {
  const gladys = fakeGladys(CONFIG);
  const delays = [];
  let attempts = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve([{ store: 'one' }]);
    },
    wait: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    retryBaseDelayMs: 1000,
  });

  assert.equal(await runtime.start(), true);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(gladys.calls.connectionStatus, [{ connected: true, message: undefined }]);
});

test('start gives up after the last attempt and reports a bilingual message', async () => {
  const gladys = fakeGladys(CONFIG);
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.reject(new Error('ECONNREFUSED')),
    wait: () => Promise.resolve(),
    retryAttempts: 2,
  });

  assert.equal(await runtime.start(), false);
  const [{ connected, message }] = gladys.calls.connectionStatus;
  assert.equal(connected, false);
  assert.deepEqual(Object.keys(message), ['en', 'fr']);
});

test('the test_connection action reports the datastore count in both languages', async () => {
  const gladys = fakeGladys(CONFIG);
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }, { store: 'two' }]),
  });

  assert.deepEqual(await runtime.testConnection(), {
    en: 'Connection successful: 2 datastore(s) found.',
    fr: 'Connexion réussie : 2 datastore(s) trouvé(s).',
  });
});

test('registerRuntime wires every SDK lifecycle hook', () => {
  const registered = [];
  const gladys = {
    onScanRequest: () => registered.push('scan'),
    onPoll: () => registered.push('poll'),
    onAction: (key) => registered.push(`action:${key}`),
    onConfigUpdated: () => registered.push('config'),
    on: (event) => registered.push(`event:${event}`),
  };

  const runtime = registerRuntime(gladys, {});
  assert.deepEqual(registered, [
    'scan',
    'poll',
    'action:test_connection',
    'config',
    'event:connected',
  ]);
  assert.deepEqual(runtime, {});
});
