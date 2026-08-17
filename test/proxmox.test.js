import assert from 'node:assert/strict';
import test from 'node:test';
import { newestSnapshotEpoch, taskSummary } from '../src/proxmox.js';

test('newestSnapshotEpoch accepts PBS backup-time fields', () => {
  assert.equal(newestSnapshotEpoch([{ 'backup-time': 10 }, { 'backup-time': 42 }]), 42);
  assert.equal(newestSnapshotEpoch([]), 0);
});

test('taskSummary selects the newest matching task', () => {
  const tasks = [
    { worker_type: 'verifyjob', status: 'old', endtime: 10 },
    { worker_type: 'verify', status: 'OK', endtime: 20 },
    { worker_type: 'prune', status: 'OK', endtime: 30 },
  ];
  assert.equal(taskSummary(tasks, 'verify'), 'OK — 1970-01-01T00:00:20.000Z');
  assert.equal(taskSummary(tasks, 'gc'), 'Never run');
});
