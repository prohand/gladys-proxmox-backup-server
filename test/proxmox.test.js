import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countBackups,
  fetchTasks,
  formatTaskDate,
  newestBackupEpoch,
  pageTasks,
  ProxmoxError,
  readInventory,
  resetTypeFilterSupport,
  TASK_MAX_PAGES,
  TASK_PAGE_SIZE,
  TASK_TYPE_FILTERS,
  taskDetails,
  taskResult,
  TYPED_TASK_LIMIT,
} from '../src/proxmox.js';

test('newestBackupEpoch accepts PBS group and snapshot fields', () => {
  assert.equal(newestBackupEpoch([{ 'backup-time': 10 }, { 'backup-time': 42 }]), 42);
  assert.equal(newestBackupEpoch([{ 'last-backup': 99 }, { 'last-backup': 12 }]), 99);
  assert.equal(newestBackupEpoch([{ 'last-backup': 'n/a' }]), 0);
  assert.equal(newestBackupEpoch([]), 0);
});

test('countBackups sums the per-group counters', () => {
  assert.equal(countBackups([{ 'backup-count': 3 }, { backup_count: 4 }, {}]), 7);
  assert.equal(countBackups([]), 0);
});

test('formatTaskDate supports ISO and configurable UTC tokens', () => {
  assert.equal(formatTaskDate(20), '1970-01-01T00:00:20.000Z');
  assert.equal(formatTaskDate(20, 'DD/MM/YYYY HH:mm:ss'), '01/01/1970 00:00:20');
  assert.equal(formatTaskDate(20, 'YYYY-MM-DD HH:mm:ss'), '1970-01-01 00:00:20');
});

test('formatTaskDate shows dates in the configured time zone', () => {
  // 2026-09-23 21:30:01 UTC: a prune that ended at 23:30:01 in Paris (summer time).
  const summer = Date.UTC(2026, 8, 23, 21, 30, 1) / 1000;
  assert.equal(
    formatTaskDate(summer, 'DD/MM/YYYY HH:mm:ss', 'Europe/Paris'),
    '23/09/2026 23:30:01',
  );
  assert.equal(formatTaskDate(summer, 'iso', 'Europe/Paris'), '2026-09-23T23:30:01+02:00');
  // Winter time, and a change of day.
  const winter = Date.UTC(2026, 11, 31, 23, 30, 0) / 1000;
  assert.equal(
    formatTaskDate(winter, 'YYYY-MM-DD HH:mm:ss', 'Europe/Paris'),
    '2027-01-01 00:30:00',
  );
  assert.equal(formatTaskDate(winter, 'iso', 'America/New_York'), '2026-12-31T18:30:00-05:00');
  assert.equal(formatTaskDate(winter, 'iso', 'UTC'), '2026-12-31T23:30:00.000Z');
});

test('taskDetails selects the newest matching task', () => {
  const tasks = [
    { worker_type: 'verifyjob', status: 'old', endtime: 10 },
    { worker_type: 'verificationjob', status: 'OK', endtime: 20 },
    { worker_type: 'prune', status: 'OK', endtime: 30 },
  ];
  assert.deepEqual(taskDetails(tasks, 'verify'), {
    status: 'OK',
    date: '1970-01-01T00:00:20.000Z',
    result: 'ok',
    id: 'verificationjob:20',
    epoch: 20,
  });
  assert.deepEqual(taskDetails(tasks, 'prune'), {
    status: 'OK',
    date: '1970-01-01T00:00:30.000Z',
    result: 'ok',
    id: 'prune:30',
    epoch: 30,
  });
  assert.deepEqual(taskDetails(tasks, 'gc'), {
    status: 'Never run',
    date: 'Never run',
    result: 'never',
    id: null,
    epoch: null,
  });
});

test('taskDetails identifies a run by its UPID', () => {
  const upid = 'UPID:pbs:00001234:0000ABCD:00000001:66C0FFEE:garbage_collection:store1:root@pam:';
  assert.equal(
    taskDetails([{ worker_type: 'garbage_collection', upid, status: 'OK', endtime: 5 }], 'gc').id,
    upid,
  );
});

test('taskResult reduces PBS statuses to ok, warning, error, or running', () => {
  assert.equal(taskResult(undefined), 'never');
  assert.equal(taskResult({ starttime: 1 }), 'running');
  assert.equal(taskResult({ starttime: 1, endtime: 2 }), 'ok');
  assert.equal(taskResult({ status: 'OK', endtime: 2 }), 'ok');
  assert.equal(taskResult({ status: 'WARNINGS: 3', endtime: 2 }), 'warning');
  assert.equal(taskResult({ status: 'unknown', endtime: 2 }), 'error');
  assert.equal(
    taskResult({ status: 'verification failed - please check the log', endtime: 2 }),
    'error',
  );
});

test('pageTasks pages until every task type has been seen', async () => {
  const pages = [
    Array.from({ length: TASK_PAGE_SIZE }, () => ({ worker_type: 'backup', endtime: 1 })),
    [
      { worker_type: 'verify', endtime: 2 },
      { worker_type: 'gc', endtime: 3 },
      { worker_type: 'prune', endtime: 4 },
    ],
    [{ worker_type: 'backup', endtime: 5 }],
  ];
  const calls = [];
  const client = {
    getTasks(store, options) {
      calls.push({ store, ...options });
      return Promise.resolve(pages[options.start / TASK_PAGE_SIZE] ?? []);
    },
  };

  const tasks = await pageTasks(client, 'backup-store');
  assert.equal(tasks.length, TASK_PAGE_SIZE + 3);
  assert.deepEqual(calls, [
    { store: 'backup-store', start: 0, limit: TASK_PAGE_SIZE },
    { store: 'backup-store', start: TASK_PAGE_SIZE, limit: TASK_PAGE_SIZE },
  ]);
});

test('pageTasks stops on a short page and respects the page budget', async () => {
  const shortPage = { getTasks: () => Promise.resolve([{ worker_type: 'backup' }]) };
  assert.equal((await pageTasks(shortPage, 'store')).length, 1);

  let requests = 0;
  const endlessPages = {
    getTasks() {
      requests += 1;
      return Promise.resolve(
        Array.from({ length: TASK_PAGE_SIZE }, () => ({ worker_type: 'backup' })),
      );
    },
  };
  await pageTasks(endlessPages, 'store');
  assert.equal(requests, TASK_MAX_PAGES);
});

const silentLogger = { warn: () => {} };

test('readInventory prefers the cheap groups route', async () => {
  const client = {
    getGroups: () =>
      Promise.resolve([
        { 'backup-count': 2, 'last-backup': 100 },
        { 'backup-count': 5, 'last-backup': 300 },
      ]),
    getSnapshots: () => assert.fail('snapshots must not be listed when groups are available'),
  };
  assert.deepEqual(await readInventory(client, 'store', silentLogger), {
    snapshotCount: 7,
    newestBackupEpoch: 300,
    source: 'groups',
  });
});

test('readInventory falls back to the snapshot list', async () => {
  const missingRoute = {
    getGroups: () =>
      Promise.reject(
        new ProxmoxError('http', { en: 'PBS answered HTTP 404', fr: 'HTTP 404' }, { status: 404 }),
      ),
    getSnapshots: () => Promise.resolve([{ 'backup-time': 10 }, { 'backup-time': 60 }]),
  };
  const warnings = [];
  assert.deepEqual(await readInventory(missingRoute, 'store', { warn: (m) => warnings.push(m) }), {
    snapshotCount: 2,
    newestBackupEpoch: 60,
    source: 'snapshots',
  });
  assert.match(warnings[0], /HTTP 404/);

  const groupsWithoutCounters = {
    getGroups: () => Promise.resolve([{ 'backup-id': 'vm/100' }]),
    getSnapshots: () => Promise.resolve([{ 'backup-time': 5 }]),
  };
  assert.deepEqual(await readInventory(groupsWithoutCounters, 'store', silentLogger), {
    snapshotCount: 1,
    newestBackupEpoch: 5,
    source: 'snapshots',
  });
});

test('readInventory does not fall back to the snapshot list on a timeout or a cut connection', async () => {
  for (const kind of ['timeout', 'network', 'auth']) {
    const client = {
      getGroups: () => Promise.reject(new ProxmoxError(kind, { en: kind, fr: kind })),
      getSnapshots: () => assert.fail(`no snapshot listing after a ${kind} error`),
    };
    await assert.rejects(readInventory(client, 'store', silentLogger), { kind });
  }
  const badRequest = {
    getGroups: () =>
      Promise.reject(new ProxmoxError('http', { en: '400', fr: '400' }, { status: 400 })),
    getSnapshots: () => Promise.resolve([{ 'backup-time': 7 }]),
  };
  assert.equal((await readInventory(badRequest, 'store', silentLogger)).source, 'snapshots');
});

test('fetchTasks asks PBS for each task type with a filter instead of paging', async () => {
  resetTypeFilterSupport();
  const calls = [];
  const client = {
    config: { base_url: 'https://typed:8007' },
    getTasks(store, options) {
      calls.push({ store, ...options });
      if (options.typefilter === 'garbage') return Promise.resolve([]);
      return Promise.resolve([
        {
          worker_type: options.typefilter === 'prune' ? 'prunejob' : 'verificationjob',
          endtime: 9,
        },
      ]);
    },
  };
  const tasks = await fetchTasks(client, 'store');
  assert.deepEqual(
    calls.map(({ typefilter, limit, start }) => ({ typefilter, limit, start })),
    Object.values(TASK_TYPE_FILTERS).map((typefilter) => ({
      typefilter,
      limit: TYPED_TASK_LIMIT,
      start: 0,
    })),
  );
  assert.equal(tasks.length, 2);
  // A type that never ran costs one empty answer, not four pages of 500 tasks.
  assert.equal(taskDetails(tasks, 'gc').result, 'never');
  assert.equal(taskDetails(tasks, 'prune').result, 'ok');
});

test('fetchTasks falls back to paging, once and for good, on a PBS refusing the filter', async () => {
  resetTypeFilterSupport();
  const calls = [];
  const warnings = [];
  const client = {
    config: { base_url: 'https://old:8007' },
    getTasks(store, options) {
      calls.push(options.typefilter ?? 'page');
      if (options.typefilter)
        return Promise.reject(new ProxmoxError('http', { en: '400', fr: '400' }, { status: 400 }));
      return Promise.resolve([{ worker_type: 'prune', endtime: 1 }]);
    },
  };
  const log = { warn: (message) => warnings.push(message) };
  assert.equal((await fetchTasks(client, 'store', undefined, log)).length, 1);
  assert.equal(warnings.length, 1);
  calls.length = 0;
  await fetchTasks(client, 'store', undefined, log);
  assert.deepEqual(calls, ['page']);

  // Any other failure is the refresh's failure, not a reason to page.
  resetTypeFilterSupport();
  const down = {
    config: { base_url: 'https://down:8007' },
    getTasks: () => Promise.reject(new ProxmoxError('timeout', { en: 't', fr: 't' })),
  };
  await assert.rejects(fetchTasks(down, 'store', undefined, log), { kind: 'timeout' });
});
