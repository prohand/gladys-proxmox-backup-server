import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countBackups,
  fetchTasks,
  formatTaskDate,
  newestBackupEpoch,
  readInventory,
  TASK_MAX_PAGES,
  TASK_PAGE_SIZE,
  taskDetails,
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

test('taskDetails selects the newest matching task', () => {
  const tasks = [
    { worker_type: 'verifyjob', status: 'old', endtime: 10 },
    { worker_type: 'verificationjob', status: 'OK', endtime: 20 },
    { worker_type: 'prune', status: 'OK', endtime: 30 },
  ];
  assert.deepEqual(taskDetails(tasks, 'verify'), {
    status: 'OK',
    date: '1970-01-01T00:00:20.000Z',
  });
  assert.deepEqual(taskDetails(tasks, 'prune'), {
    status: 'OK',
    date: '1970-01-01T00:00:30.000Z',
  });
  assert.deepEqual(taskDetails(tasks, 'gc'), { status: 'Never run', date: 'Never run' });
});

test('fetchTasks pages until every task type has been seen', async () => {
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

  const tasks = await fetchTasks(client, 'backup-store');
  assert.equal(tasks.length, TASK_PAGE_SIZE + 3);
  assert.deepEqual(calls, [
    { store: 'backup-store', start: 0, limit: TASK_PAGE_SIZE },
    { store: 'backup-store', start: TASK_PAGE_SIZE, limit: TASK_PAGE_SIZE },
  ]);
});

test('fetchTasks stops on a short page and respects the page budget', async () => {
  const shortPage = { getTasks: () => Promise.resolve([{ worker_type: 'backup' }]) };
  assert.equal((await fetchTasks(shortPage, 'store')).length, 1);

  let requests = 0;
  const endlessPages = {
    getTasks() {
      requests += 1;
      return Promise.resolve(
        Array.from({ length: TASK_PAGE_SIZE }, () => ({ worker_type: 'backup' })),
      );
    },
  };
  await fetchTasks(endlessPages, 'store');
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
    getGroups: () => Promise.reject(new Error('PBS API returned HTTP 404')),
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
