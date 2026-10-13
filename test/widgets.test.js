import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { summarizeDatastore } from '../src/datastores.js';
import { LANGUAGES } from '../src/i18n.js';
import { loadingContent } from '../src/widgetDeadline.js';
import {
  datastoreWidgetContent,
  formatSize,
  missingDatastoreContent,
  overviewWidgetContent,
} from '../src/widgets.js';

const NOW = 1_700_000_000_000;

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};

function summary(used = 1_992_600_000_000, total = 2_875_800_000_000) {
  return summarizeDatastore(
    { store: 'nas', total, used },
    { snapshotCount: 250, newestBackupEpoch: NOW / 1000 - 3600 },
    [],
    NOW,
  );
}

const tiles = (content) =>
  content.components.filter(({ type }) => type === 'value' || type === 'gauge');

test('sizes are short and localized', () => {
  assert.deepEqual(formatSize(0.5), { en: '0.5 GB', fr: '0,5 Go', de: '0,5 GB', es: '0,5 GB' });
  assert.deepEqual(formatSize(883.2), { en: '883 GB', fr: '883 Go', de: '883 GB', es: '883 GB' });
  assert.deepEqual(formatSize(2875.8), {
    en: '2.88 TB',
    fr: '2,88 To',
    de: '2,88 TB',
    es: '2,88 TB',
  });
  assert.deepEqual(formatSize(3000), { en: '3 TB', fr: '3 To', de: '3 TB', es: '3 TB' });
});

test('both widgets fill whole rows of three tiles with rounded values', () => {
  const datastore = datastoreWidgetContent(gladys, summary());
  const overview = overviewWidgetContent([summary()]);
  for (const content of [datastore, overview]) {
    assert.deepEqual(validateWidgetContent(content), []);
    assert.equal(tiles(content).length, 3);
    assert.equal(tiles(content).find(({ type }) => type === 'gauge').value, 69);
  }
  const free = tiles(datastore).find(({ label }) => label.en === 'Free');
  assert.deepEqual([free.value.fr, free.unit.fr], ['883', 'Go']);
  const space = datastore.components.find(({ type }) => type === 'status').items[1];
  assert.deepEqual(space.value, {
    en: '1.99 TB / 2.88 TB',
    fr: '1,99 To / 2,88 To',
    de: '1,99 TB / 2,88 TB',
    es: '1,99 TB / 2,88 TB',
  });
});

test('the datastore widget shows each task as a card with its date and a result badge', () => {
  const content = datastoreWidgetContent(
    gladys,
    summarizeDatastore(
      { store: 'nas', total: 100, used: 50 },
      { snapshotCount: 1, newestBackupEpoch: NOW / 1000 },
      [
        { worker_type: 'verificationjob', status: 'OK', endtime: 1_788_670_020 },
        { worker_type: 'garbage_collection', status: 'WARNINGS: 1', endtime: 1_788_670_020 },
      ],
      NOW,
    ),
  );
  assert.deepEqual(validateWidgetContent(content), []);
  const cards = content.components.find(({ type }) => type === 'card-list').items;
  assert.deepEqual(cards[0], {
    title: { en: 'Verify', fr: 'Vérification', de: 'Verifizierung', es: 'Verificación' },
    date: '2026-09-06T04:47:00.000Z',
    badge: {
      text: { en: 'Succeeded', fr: 'Réussie', de: 'Erfolgreich', es: 'Correcta' },
      color: 'success',
    },
  });
  assert.equal(cards[1].badge.color, 'warning');
  assert.deepEqual(cards[2], {
    title: { en: 'Prune', fr: 'Prune', de: 'Prune', es: 'Prune' },
    badge: {
      text: { en: 'Never run', fr: 'Jamais lancée', de: 'Nie ausgeführt', es: 'Nunca ejecutada' },
      color: 'neutral',
    },
  });
});

test('the datastore widget can hide its three tiles', () => {
  const content = datastoreWidgetContent(gladys, summary(), { showTiles: false });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(tiles(content).length, 0);
  assert.deepEqual(
    content.components.map(({ type }) => type),
    ['text', 'card-list', 'status', 'button'],
  );
});

test('an offline datastore shows its capacity as unknown, never as an empty datastore', () => {
  const offline = summarizeDatastore(
    { store: 'nas' },
    { snapshotCount: 250, newestBackupEpoch: NOW / 1000 - 3600 },
    [],
    NOW,
  );
  const datastore = datastoreWidgetContent(gladys, offline);
  const overview = overviewWidgetContent([offline, summary()]);
  for (const content of [datastore, overview]) assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(tiles(datastore).length, 3);
  assert.ok(!tiles(datastore).some(({ type }) => type === 'gauge'));
  const text = JSON.stringify(datastore);
  assert.ok(text.includes('Indisponible') && !text.includes('"0 %"'));
  // The fullest datastore with a known capacity drives the overview gauge.
  assert.equal(tiles(overview)[0].value, 69);
  assert.ok(!JSON.stringify(overview).includes('NaN'));
});

// Every localized text of a card: an object whose values are all strings and
// that carries `en`.
function localizedTexts(node, found = []) {
  if (Array.isArray(node)) node.forEach((item) => localizedTexts(item, found));
  else if (node && typeof node === 'object') {
    const values = Object.values(node);
    if ('en' in node && values.every((value) => typeof value === 'string')) found.push(node);
    else values.forEach((value) => localizedTexts(value, found));
  }
  return found;
}

test('every widget text is written in English, French, German and Spanish', () => {
  const offline = summarizeDatastore({ store: 'nas' }, {}, [], NOW);
  const contents = [
    datastoreWidgetContent(gladys, summary()),
    datastoreWidgetContent(gladys, offline),
    overviewWidgetContent(
      [
        summary(),
        offline,
        { ...summary(), stale: true },
        summarizeDatastore(
          { store: 'bad', total: 100, used: 95 },
          { snapshotCount: 1, newestBackupEpoch: NOW / 1000 },
          [{ worker_type: 'prune', status: 'error: disk full', endtime: 1 }],
          NOW,
        ),
      ],
      new Map([['down', new Error('x')]]),
    ),
    missingDatastoreContent(),
    loadingContent(),
  ];
  for (const content of contents) {
    assert.deepEqual(validateWidgetContent(content), []);
    const texts = localizedTexts(content);
    assert.ok(texts.length > 0);
    for (const text of texts) assert.deepEqual(Object.keys(text), LANGUAGES, JSON.stringify(text));
  }
});
