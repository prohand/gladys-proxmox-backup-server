import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { summarizeDatastore } from '../src/datastores.js';
import { createRuntime, registerRuntime } from '../src/runtime.js';

function fakeGladys(config = {}) {
  const calls = { discovered: [], states: [], connectionStatus: [], events: [], nudges: [] };
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
    publishSceneEvent(key, data) {
      calls.events.push({ key, data });
      return Promise.resolve();
    },
    requestWidgetRefresh(key) {
      calls.nudges.push(key);
    },
  };
}

const CONFIG = { base_url: 'https://pbs:8007', poll_frequency: 900 };
const DEVICE = 'ext:test:pbs-datastore:one';
const NOW = 1_000_000_000_000;

function summary({ store = 'one', newest = NOW / 1000 - 3600, tasks = [], used = 5e8 } = {}) {
  return summarizeDatastore(
    { store, total: 1e9, used },
    { snapshotCount: 3, newestBackupEpoch: newest },
    tasks,
    NOW,
  );
}

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
    readSummary: () => {
      reads += 1;
      return Promise.resolve(summary());
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
    readSummary: () => Promise.resolve(summary()),
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
    readSummary: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('PBS API request timed out'));
      return Promise.resolve(summary());
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
    readSummary: () => {
      reads += 1;
      return Promise.resolve(summary());
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
    onWidgetGet: (key) => registered.push(`widget:${key}`),
    onWidgetAction: (key) => registered.push(`widgetAction:${key}`),
    onSceneAction: (key) => registered.push(`sceneAction:${key}`),
    onConfigUpdated: () => registered.push('config'),
    on: (event) => registered.push(`event:${event}`),
  };

  const runtime = registerRuntime(gladys, {});
  assert.deepEqual(registered, [
    'scan',
    'poll',
    'action:test_connection',
    'widget:datastore',
    'widget:overview',
    'widgetAction:datastore',
    'widgetAction:overview',
    'sceneAction:get_datastore_status',
    'sceneAction:get_backup_report',
    'config',
    'event:connected',
  ]);
  assert.deepEqual(runtime, {});
});

// Drives the runtime through scheduled polls, one refresh interval apart,
// each one answered by the next summary of `reads`.
function pollingRuntime(gladys, reads) {
  let clock = NOW;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readSummary: () => {
      const next = reads.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    now: () => clock,
  });
  return {
    runtime,
    // A failed refresh rejects the poll; the outage tests only look at events.
    async pollNext({ ignoreErrors = true } = {}) {
      clock += 900_000;
      const polled = runtime.poll({ external_id: DEVICE });
      await (ignoreErrors ? polled.catch(() => {}) : polled);
    },
  };
}

test('the first refresh after a start fires no scene event', async () => {
  const gladys = fakeGladys(CONFIG);
  const { runtime, pollNext } = pollingRuntime(gladys, [
    summary({ tasks: [{ worker_type: 'prune', upid: 'p1', status: 'OK', endtime: 5 }] }),
  ]);
  await runtime.updateConfig(CONFIG);
  await pollNext();
  assert.deepEqual(gladys.calls.events, []);
  assert.deepEqual(gladys.calls.nudges, ['datastore', 'overview']);
});

test('a finished task and a new backup fire their scene triggers once', async () => {
  const gladys = fakeGladys(CONFIG);
  const running = { worker_type: 'verificationjob', upid: 'v1', starttime: 10 };
  const failed = { ...running, endtime: 20, status: 'verification failed' };
  const { runtime, pollNext } = pollingRuntime(gladys, [
    summary({ newest: NOW / 1000 - 7200, tasks: [running] }),
    summary({ tasks: [failed] }),
    summary({ tasks: [failed] }),
  ]);
  await runtime.updateConfig(CONFIG);
  await pollNext();
  await pollNext();
  await pollNext();

  assert.deepEqual(
    gladys.calls.events.map(({ key }) => key),
    ['task_finished', 'new_backup'],
  );
  assert.deepEqual(gladys.calls.events[0].data, {
    datastore: DEVICE,
    datastore_name: 'one',
    task_type: 'verify',
    result: 'error',
    status: 'verification failed',
    date: '1970-01-01T00:00:20.000Z',
  });
  assert.equal(gladys.calls.events[1].data.snapshot_count, 3);
});

test('a backup turning stale fires backup_stale on the transition only', async () => {
  const gladys = fakeGladys(CONFIG);
  const old = NOW / 1000 - 30 * 3600;
  const { runtime, pollNext } = pollingRuntime(gladys, [
    summary(),
    summary({ newest: old }),
    summary({ newest: old }),
  ]);
  await runtime.updateConfig(CONFIG);
  await pollNext();
  await pollNext();
  await pollNext();

  assert.deepEqual(gladys.calls.events, [
    {
      key: 'backup_stale',
      data: {
        datastore: DEVICE,
        datastore_name: 'one',
        last_backup: new Date(old * 1000).toISOString(),
        hours_since_backup: 30,
      },
    },
  ]);
});

test('an unreachable PBS fires one event per outage, then one on recovery', async () => {
  const gladys = fakeGladys(CONFIG);
  const { runtime, pollNext } = pollingRuntime(gladys, [
    summary(),
    new Error('connect ECONNREFUSED'),
    new Error('connect ECONNREFUSED'),
    summary(),
  ]);
  await runtime.updateConfig(CONFIG);
  for (let index = 0; index < 4; index += 1) await pollNext();

  assert.deepEqual(gladys.calls.events, [
    {
      key: 'pbs_unreachable',
      data: { datastore: DEVICE, datastore_name: 'one', error: 'connect ECONNREFUSED' },
    },
    { key: 'pbs_reachable', data: { datastore: DEVICE, datastore_name: 'one' } },
  ]);
});

test('a scene event refused by Gladys does not fail the refresh', async () => {
  const gladys = fakeGladys(CONFIG);
  gladys.publishSceneEvent = () => Promise.reject(new Error('HTTP 429'));
  const { runtime, pollNext } = pollingRuntime(gladys, [
    summary(),
    summary({ newest: NOW / 1000 }),
  ]);
  await runtime.updateConfig(CONFIG);
  await pollNext({ ignoreErrors: false });
  await assert.doesNotReject(pollNext({ ignoreErrors: false }));
  assert.equal(gladys.calls.states.length, 2);
});

test('a refresh asked by a scene action never fires a scene event itself', async () => {
  const gladys = fakeGladys(CONFIG);
  const { runtime, pollNext } = pollingRuntime(gladys, [
    summary(),
    summary({ newest: NOW / 1000 }),
    summary({ newest: NOW / 1000 }),
  ]);
  await runtime.updateConfig(CONFIG);
  await pollNext();

  const outputs = await runtime.getDatastoreStatus({ datastore: DEVICE, refresh: true });
  assert.equal(outputs.hours_since_backup, 0);
  assert.deepEqual(gladys.calls.events, []);

  // The change is still reported, by the next scheduled poll.
  await pollNext();
  assert.deepEqual(
    gladys.calls.events.map(({ key }) => key),
    ['new_backup'],
  );
});

test('get_datastore_status serves the last refresh unless asked to read PBS', async () => {
  const gladys = fakeGladys(CONFIG);
  let reads = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readSummary: () => {
      reads += 1;
      return Promise.resolve(summary());
    },
    now: () => NOW,
  });
  await runtime.updateConfig(CONFIG);

  const outputs = await runtime.getDatastoreStatus({ datastore: DEVICE });
  await runtime.getDatastoreStatus({ datastore: DEVICE, refresh: false });
  assert.equal(reads, 1);
  await runtime.getDatastoreStatus({ datastore: DEVICE, refresh: true });
  assert.equal(reads, 2);

  assert.equal(outputs.datastore_name, 'one');
  assert.equal(outputs.usage_percent, 50);
  assert.equal(outputs.backup_stale, false);
  assert.equal(outputs.last_verify_status, 'Never run');
  await assert.rejects(runtime.getDatastoreStatus({ datastore: 'ext:test:nope' }), /Unknown/);
});

test('get_backup_report counts problems and lists unreachable datastores', async () => {
  const gladys = fakeGladys(CONFIG);
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }, { store: 'two' }, { store: 'off' }]),
    readSummary: (store) => {
      if (store === 'off') return Promise.reject(new Error('timeout'));
      if (store === 'two') return Promise.resolve(summary({ store, newest: 0, used: 9.5e8 }));
      return Promise.resolve(summary({ store }));
    },
    now: () => NOW,
  });
  await runtime.updateConfig(CONFIG);

  const report = await runtime.getBackupReport({ language: 'fr' });
  assert.deepEqual(
    { ...report, summary: undefined },
    {
      datastore_count: 3,
      stale_count: 1,
      failed_task_count: 0,
      unreachable_count: 1,
      max_usage_percent: 95,
      all_ok: false,
      summary: undefined,
    },
  );
  assert.equal(
    report.summary,
    [
      'Sauvegardes PBS : à vérifier',
      'one : OK (utilisé 50 %)',
      'two : aucune sauvegarde (utilisé 95 %)',
      'off : PBS injoignable',
    ].join('\n'),
  );
});

test('both widgets resolve content the Gladys core renders as sent', async () => {
  const gladys = fakeGladys(CONFIG);
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }, { store: 'off' }]),
    readSummary: (store) =>
      store === 'off'
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve(
            summary({
              tasks: [
                { worker_type: 'verificationjob', status: 'WARNINGS: 2', endtime: 1_700_000_000 },
                { worker_type: 'garbage_collection', status: 'OK', endtime: 1_700_000_000 },
                { worker_type: 'prune', starttime: 1_700_000_000 },
              ],
            }),
          ),
    now: () => NOW,
  });
  await runtime.updateConfig(CONFIG);

  const datastore = await runtime.datastoreWidget({ settings: { datastore: DEVICE } });
  const overview = await runtime.overviewWidget();
  const missing = await runtime.datastoreWidget({ settings: { datastore: 'ext:test:nope' } });
  for (const content of [datastore, overview, missing])
    assert.deepEqual(validateWidgetContent(content), []);

  const status = datastore.components.find(({ type }) => type === 'status');
  assert.deepEqual(
    status.items.map(({ value }) => value.fr ?? value),
    [
      new Date((NOW / 1000 - 3600) * 1000).toISOString(),
      'Avertissements · 2023-11-14T22:13:20Z',
      'OK · 2023-11-14T22:13:20Z',
      'En cours · 2023-11-14T22:13:20Z',
    ],
  );
  assert.deepEqual(
    overview.components.find(({ type }) => type === 'status').items.map(({ label }) => label),
    ['one', 'off'],
  );
});

test('widget refresh buttons read PBS again and answer with a toast', async () => {
  const gladys = fakeGladys(CONFIG);
  let reads = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readSummary: () => {
      reads += 1;
      return Promise.resolve(summary());
    },
    now: () => NOW,
  });
  await runtime.updateConfig(CONFIG);

  await runtime.datastoreWidget({ settings: { datastore: DEVICE } });
  assert.deepEqual(
    await runtime.refreshDatastoreWidget('refresh', {}, { settings: { datastore: DEVICE } }),
    { en: 'Datastore refreshed', fr: 'Datastore actualisé' },
  );
  assert.deepEqual(await runtime.refreshOverviewWidget(), {
    en: 'Datastores refreshed',
    fr: 'Datastores actualisés',
  });
  assert.equal(reads, 3);
  assert.equal(gladys.calls.states.length, 3);
});
