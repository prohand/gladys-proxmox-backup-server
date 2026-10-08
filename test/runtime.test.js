import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { DatastoreMissingError, summarizeDatastore } from '../src/datastores.js';
import { ProxmoxError } from '../src/proxmox.js';
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
    onDeviceCreated: () => registered.push('deviceCreated'),
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
    'deviceCreated',
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
    [new Date((NOW / 1000 - 3600) * 1000).toISOString(), '0,5 Go / 1 Go'],
  );
  const cards = datastore.components.find(({ type }) => type === 'card-list').items;
  assert.deepEqual(
    cards.map(({ date, badge }) => [date, badge.text.fr]),
    [
      ['2023-11-14T22:13:20.000Z', 'Avertissements'],
      ['2023-11-14T22:13:20.000Z', 'Réussie'],
      ['2023-11-14T22:13:20.000Z', 'En cours'],
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

test('the connection status follows the polls after a failed start', async () => {
  const gladys = fakeGladys(CONFIG);
  let up = false;
  let clock = NOW;
  const runtime = createRuntime(gladys, {
    listDatastores: () =>
      up ? Promise.resolve([{ store: 'one' }]) : Promise.reject(new Error('ECONNREFUSED')),
    readSummary: () => (up ? Promise.resolve(summary()) : Promise.reject(new Error('timed out'))),
    wait: () => Promise.resolve(),
    now: () => clock,
  });
  assert.equal(await runtime.start(), false);
  assert.equal(gladys.calls.connectionStatus.at(-1).connected, false);

  up = true;
  await runtime.poll({ external_id: DEVICE });
  assert.equal(gladys.calls.connectionStatus.at(-1).connected, true);

  up = false;
  clock += CONFIG.poll_frequency * 1000;
  await assert.rejects(runtime.poll({ external_id: DEVICE }), /timed out/);
  const last = gladys.calls.connectionStatus.at(-1);
  assert.equal(last.connected, false);
  assert.match(last.message.fr, /injoignable : timed out/);

  const reported = gladys.calls.connectionStatus.length;
  await assert.rejects(runtime.poll({ external_id: DEVICE }), /timed out/);
  assert.equal(gladys.calls.connectionStatus.length, reported, 'reported once per change');
});

test('an unknown device asks for a discovery once per refresh interval', async () => {
  const gladys = fakeGladys(CONFIG);
  let clock = NOW;
  let discoveries = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => {
      discoveries += 1;
      return Promise.resolve([{ store: 'one' }]);
    },
    readSummary: () => Promise.resolve(summary()),
    now: () => clock,
  });
  await runtime.updateConfig(CONFIG);
  const deleted = { external_id: 'ext:test:pbs-datastore:deleted' };

  await runtime.poll(deleted);
  clock += 60_000;
  await runtime.poll(deleted);
  assert.equal(discoveries, 2);

  clock += CONFIG.poll_frequency * 1000;
  await runtime.poll(deleted);
  assert.equal(discoveries, 3);
});

test('a datastore removed from PBS turns the status green again and is looked up ever less often', async () => {
  const gladys = fakeGladys(CONFIG);
  let clock = NOW;
  let listed = [{ store: 'one' }, { store: 'gone' }];
  let discoveries = 0;
  const reads = [];
  const runtime = createRuntime(gladys, {
    listDatastores: () => {
      discoveries += 1;
      return Promise.resolve(listed);
    },
    readSummary: (store) => {
      reads.push(store);
      if (store === 'gone') return Promise.reject(new Error('PBS API request timed out'));
      return Promise.resolve(summary({ store }));
    },
    now: () => clock,
  });
  await runtime.updateConfig(CONFIG);
  const gone = { external_id: 'ext:test:pbs-datastore:gone' };

  await assert.rejects(runtime.poll(gone), /timed out/);
  assert.equal(gladys.calls.connectionStatus.at(-1).connected, false);

  // The datastore is deleted on PBS; a scan (or any discovery) forgets its error.
  listed = [{ store: 'one' }];
  await runtime.discover();
  assert.equal(gladys.calls.connectionStatus.at(-1).connected, true);

  // Its device lives on in Gladys and keeps being polled every minute: the
  // lookups back off (1, 2, 4 refresh intervals) and the datastore is never read.
  discoveries = 0;
  reads.length = 0;
  const lookups = [];
  for (let minute = 0; minute < 8 * 15 + 1; minute += 1) {
    const before = discoveries;
    await runtime.poll(gone);
    if (discoveries > before) lookups.push(minute);
    clock += 60_000;
  }
  assert.deepEqual(lookups, [0, 15, 45, 105]);
  assert.deepEqual(reads, []);
});

test('a datastore PBS no longer lists is dropped at once, without an unreachable event', async () => {
  const gladys = fakeGladys(CONFIG);
  let listed = [{ store: 'one' }];
  let clock = NOW;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve(listed),
    readSummary: (store, config, at, { readUsage }) =>
      readUsage().then((stores) =>
        stores.some((item) => item.store === store)
          ? summary({ store })
          : Promise.reject(new DatastoreMissingError(store)),
      ),
    now: () => clock,
  });
  await runtime.updateConfig(CONFIG);
  listed = [];
  clock += 60_000;
  await runtime.poll({ external_id: DEVICE });
  assert.deepEqual(gladys.calls.events, []);
  assert.deepEqual(gladys.calls.connectionStatus, []);
  assert.deepEqual(gladys.calls.discovered.at(-1), []);
});

test('a Gladys failure to store the states is not reported as PBS unreachable', async () => {
  const gladys = fakeGladys(CONFIG);
  let refuse = true;
  gladys.publishStates = (states) => {
    if (refuse) return Promise.reject(new Error('Gladys is restarting'));
    gladys.calls.states.push(states);
    return Promise.resolve();
  };
  let reads = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readSummary: () => {
      reads += 1;
      return Promise.resolve(summary());
    },
    now: () => NOW,
  });
  await runtime.start();

  await assert.rejects(runtime.poll({ external_id: DEVICE }), /Gladys did not store/);
  assert.deepEqual(gladys.calls.events, []);
  assert.ok(gladys.calls.connectionStatus.every(({ connected }) => connected));

  // Retried on the next tick rather than a full refresh interval later.
  refuse = false;
  await runtime.poll({ external_id: DEVICE });
  assert.equal(reads, 2);
  assert.equal(gladys.calls.states.length, 1);
});

test('concurrent reads of one datastore share a single PBS read', async () => {
  const gladys = fakeGladys(CONFIG);
  let reads = 0;
  let release;
  const runtime = createRuntime(gladys, {
    listDatastores: () => Promise.resolve([{ store: 'one' }]),
    readSummary: () => {
      reads += 1;
      return new Promise((resolve) => {
        release = () => resolve(summary());
      });
    },
    now: () => NOW,
  });
  await runtime.updateConfig(CONFIG);

  const pending = [
    runtime.datastoreWidget({ settings: { datastore: DEVICE } }),
    runtime.getDatastoreStatus({ datastore: DEVICE }),
    runtime.poll({ external_id: DEVICE }),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all(pending);
  assert.equal(reads, 1);
  assert.equal(gladys.calls.states.length, 1);
});

test('the datastores of one tick share one datastore-usage read', async () => {
  const gladys = fakeGladys(CONFIG);
  let clock = NOW;
  let usageReads = 0;
  const runtime = createRuntime(gladys, {
    listDatastores: () => {
      usageReads += 1;
      return Promise.resolve([{ store: 'one' }, { store: 'two' }]);
    },
    readSummary: (store, config, at, { readUsage }) => readUsage().then(() => summary({ store })),
    now: () => clock,
  });
  await runtime.updateConfig(CONFIG);
  clock += 900_000;
  usageReads = 0;
  await runtime.poll({ external_id: 'ext:test:pbs-datastore:one' });
  await runtime.poll({ external_id: 'ext:test:pbs-datastore:two' });
  assert.equal(usageReads, 1);
  assert.equal(gladys.calls.states.length, 2);
});

test('a device created in Gladys is read at once, even inside the refresh interval', async () => {
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
  await runtime.poll({ external_id: DEVICE });
  await runtime.deviceCreated({ external_id: DEVICE });
  assert.equal(reads, 2);
  assert.equal(gladys.calls.states.length, 2);
});

test('test_connection reports a PBS error in both languages', async () => {
  const gladys = fakeGladys(CONFIG);
  const runtime = createRuntime(gladys, {
    listDatastores: () =>
      Promise.reject(new ProxmoxError('auth', { en: 'token refused', fr: 'jeton refusé' })),
  });
  await assert.rejects(runtime.testConnection(), { message: 'token refused / jeton refusé' });
});
