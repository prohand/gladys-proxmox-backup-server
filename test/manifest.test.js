import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { summarizeDatastore } from '../src/datastores.js';
import {
  backupReportOutputs,
  datastoreStatusOutputs,
  detectSceneEvents,
  reachableEvent,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
  unreachableEvent,
} from '../src/scenes.js';
import { WIDGETS } from '../src/widgets.js';

test('manifest describes a read-only device integration', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../gladys-assistant-integration.json', import.meta.url)),
  );
  assert.equal(manifest.name, 'Proxmox Backup Server');
  assert.equal(manifest.type, 'device');
  assert.ok(
    manifest.config_schema.some(({ key, type }) => key === 'api_token_secret' && type === 'secret'),
  );
  const refreshInterval = manifest.config_schema.find(({ key }) => key === 'poll_frequency');
  assert.deepEqual(
    {
      default: refreshInterval.default,
      min: refreshInterval.min,
      max: refreshInterval.max,
    },
    { default: 900, min: 300, max: 86_400 },
  );
  const dateFormat = manifest.config_schema.find(({ key }) => key === 'date_format');
  assert.equal(dateFormat.type, 'select');
  assert.equal(dateFormat.display, 'dropdown');
  assert.equal(dateFormat.default, 'iso');
  assert.deepEqual(
    dateFormat.options.map(({ value }) => value),
    ['iso', 'DD/MM/YYYY HH:mm:ss', 'YYYY-MM-DD HH:mm:ss', 'MM/DD/YYYY HH:mm:ss'],
  );
});

async function readManifest() {
  return JSON.parse(
    await readFile(new URL('../gladys-assistant-integration.json', import.meta.url)),
  );
}

test('widgets, scene triggers, and scene actions need Gladys 5.1', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.deepEqual(
    manifest.widgets.map(({ key }) => key),
    Object.values(WIDGETS),
  );
  assert.deepEqual(
    manifest.scene_triggers.map(({ key }) => key),
    Object.values(SCENE_TRIGGERS),
  );
  assert.deepEqual(
    manifest.scene_actions.map(({ key }) => key),
    Object.values(SCENE_ACTIONS),
  );
});

test('every declared label and description is bilingual', async () => {
  const manifest = await readManifest();
  const texts = [];
  const collect = (entry) => {
    for (const key of ['label', 'description']) if (entry[key]) texts.push(entry[key]);
    for (const list of ['settings', 'fields', 'variables', 'outputs', 'options'])
      (entry[list] ?? []).forEach(collect);
  };
  [...manifest.widgets, ...manifest.scene_triggers, ...manifest.scene_actions].forEach(collect);
  for (const text of texts) assert.deepEqual(Object.keys(text).sort(), ['en', 'fr']);
});

test('scene events and outputs only carry declared keys', async () => {
  const manifest = await readManifest();
  const declared = (list, key, property) =>
    manifest[list].find((entry) => entry.key === key)[property].map((item) => item.key);
  const summary = summarizeDatastore(
    { store: 'one', total: 1e9, used: 5e8 },
    { snapshotCount: 3, newestBackupEpoch: 1 },
    [{ worker_type: 'prune', status: 'OK', endtime: 5 }],
    1e12,
  );
  const previous = { ...summary, newestBackupEpoch: 0, stale: false, tasks: {} };
  const events = [
    ...detectSceneEvents(previous, summary, 'ext:device'),
    unreachableEvent('one', 'ext:device', new Error('down')),
    reachableEvent('one', 'ext:device'),
  ];
  assert.deepEqual(
    [...new Set(events.map(({ key }) => key))].sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  for (const { key, data } of events) {
    const filters = declared('scene_triggers', key, 'fields');
    const variables = declared('scene_triggers', key, 'variables');
    assert.deepEqual(Object.keys(data).sort(), [...new Set([...filters, ...variables])].sort());
  }
  assert.deepEqual(
    Object.keys(datastoreStatusOutputs(summary)).sort(),
    declared('scene_actions', 'get_datastore_status', 'outputs').sort(),
  );
  assert.deepEqual(
    Object.keys(backupReportOutputs([summary])).sort(),
    declared('scene_actions', 'get_backup_report', 'outputs').sort(),
  );
});
