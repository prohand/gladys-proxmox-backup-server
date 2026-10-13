import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { summarizeDatastore } from '../src/datastores.js';
import { LANGUAGES } from '../src/i18n.js';
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
  const timezone = manifest.config_schema.find(({ key }) => key === 'timezone');
  assert.equal(timezone.type, 'string');
  assert.equal(timezone.default, DEFAULT_CONFIG.timezone);
});

test('every declared default matches DEFAULT_CONFIG, and the fingerprint field exists', async () => {
  const manifest = await readManifest();
  for (const field of manifest.config_schema)
    if ('default' in field) assert.deepEqual(field.default, DEFAULT_CONFIG[field.key], field.key);
  const fingerprint = manifest.config_schema.find(({ key }) => key === 'tls_fingerprint');
  assert.equal(fingerprint.type, 'string');
  assert.equal(fingerprint.required, false);
  for (const language of LANGUAGES) assert.ok(fingerprint.placeholder[language], language);
  assert.ok(Object.hasOwn(DEFAULT_CONFIG, 'tls_fingerprint'));
  const keys = manifest.config_schema.map(({ key }) => key);
  // Read before the TLS switch it overrides.
  assert.ok(keys.indexOf('tls_fingerprint') < keys.indexOf('verify_tls'));
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

// Every multi-language object of the manifest, with its path: an object whose
// values are all strings and that carries `en`.
function localizedTexts(node, path = '', found = []) {
  if (Array.isArray(node))
    node.forEach((item, index) => localizedTexts(item, `${path}[${index}]`, found));
  else if (node && typeof node === 'object') {
    const values = Object.values(node);
    if ('en' in node && values.every((value) => typeof value === 'string'))
      found.push({ path, text: node });
    else
      for (const [key, value] of Object.entries(node))
        localizedTexts(value, `${path}.${key}`, found);
  }
  return found;
}

test('every manifest text is written in English, French, German and Spanish', async () => {
  const manifest = await readManifest();
  const texts = localizedTexts(manifest);
  // Catalog description, config fields, section link, action, widgets, scenes.
  assert.ok(texts.length > 100, `only ${texts.length} texts found`);
  for (const { path, text } of texts) {
    assert.deepEqual(Object.keys(text), LANGUAGES, path);
    for (const language of LANGUAGES) assert.ok(text[language].trim(), `${path}.${language}`);
  }
  // Every label and description of the capabilities is one of them.
  const collected = new Set(texts.map(({ text }) => text));
  const collect = (entry) => {
    for (const key of ['label', 'description'])
      if (entry[key]) assert.ok(collected.has(entry[key]), JSON.stringify(entry[key]));
    for (const list of ['settings', 'fields', 'variables', 'outputs', 'options'])
      (entry[list] ?? []).forEach(collect);
  };
  [...manifest.widgets, ...manifest.scene_triggers, ...manifest.scene_actions].forEach(collect);
});

test('manifest texts respect the store length limits in every language', async () => {
  const manifest = await readManifest();
  const within = (text, min, max, what) => {
    for (const language of LANGUAGES) {
      const { length } = text[language];
      assert.ok(length >= min && length <= max, `${what}.${language}: ${length} characters`);
    }
  };
  within(manifest.description, 10, 100, 'description');
  for (const widget of manifest.widgets) {
    within(widget.label, 3, 30, `widgets.${widget.key}.label`);
    within(widget.description, 1, 100, `widgets.${widget.key}.description`);
  }
  for (const field of manifest.config_schema.filter(({ type }) => type === 'section'))
    for (const key of ['label', 'description'])
      if (field[key]) within(field[key], 1, 1000, `${field.key}.${key}`);
});

test('the backup report offers every language it is written in', async () => {
  const manifest = await readManifest();
  const language = manifest.scene_actions
    .find(({ key }) => key === SCENE_ACTIONS.GET_BACKUP_REPORT)
    .fields.find(({ key }) => key === 'language');
  assert.equal(language.default, 'en');
  assert.deepEqual(
    language.options.map(({ value }) => value),
    LANGUAGES,
  );
  for (const value of LANGUAGES)
    assert.match(backupReportOutputs([], new Map(), value).summary, /: OK$/);
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

test('the manifest declares the transports used (the PBS API is read on the local network)', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../gladys-assistant-integration.json', import.meta.url)),
  );
  assert.deepEqual(manifest.transports, ['local']);
});
