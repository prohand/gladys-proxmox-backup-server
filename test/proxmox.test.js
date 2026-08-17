import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskDate, newestSnapshotEpoch, taskDetails, taskSummary } from '../src/proxmox.js';

test('newestSnapshotEpoch accepts PBS backup-time fields', () => {
  assert.equal(newestSnapshotEpoch([{ 'backup-time': 10 }, { 'backup-time': 42 }]), 42);
  assert.equal(newestSnapshotEpoch([]), 0);
});

test('formatTaskDate supports ISO and configurable UTC tokens', () => {
  assert.equal(formatTaskDate(20), '1970-01-01T00:00:20.000Z');
  assert.equal(formatTaskDate(20, 'DD/MM/YYYY HH:mm:ss'), '01/01/1970 00:00:20');
  assert.equal(formatTaskDate(20, 'YYYY-MM-DD HH:mm:ss'), '1970-01-01 00:00:20');
});

test('taskSummary selects the newest matching task', () => {
  const tasks = [
    { worker_type: 'verifyjob', status: 'old', endtime: 10 },
    { worker_type: 'verificationjob', status: 'OK', endtime: 20 },
    { worker_type: 'prune', status: 'OK', endtime: 30 },
  ];
  assert.equal(taskSummary(tasks, 'verify'), 'OK — 1970-01-01T00:00:20.000Z');
  assert.equal(taskSummary(tasks, 'gc'), 'Never run');
  assert.deepEqual(taskDetails(tasks, 'prune'), {
    status: 'OK',
    date: '1970-01-01T00:00:30.000Z',
  });
  assert.deepEqual(taskDetails(tasks, 'gc'), { status: 'Never run', date: 'Never run' });
});
