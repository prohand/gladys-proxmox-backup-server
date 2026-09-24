import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { summarizeDatastore } from '../src/datastores.js';
import { datastoreWidgetContent, formatSize, overviewWidgetContent } from '../src/widgets.js';

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
  assert.deepEqual(formatSize(0.5), { en: '0.5 GB', fr: '0,5 Go' });
  assert.deepEqual(formatSize(883.2), { en: '883 GB', fr: '883 Go' });
  assert.deepEqual(formatSize(2875.8), { en: '2.88 TB', fr: '2,88 To' });
  assert.deepEqual(formatSize(3000), { en: '3 TB', fr: '3 To' });
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
  assert.deepEqual(space.value, { en: '1.99 TB / 2.88 TB', fr: '1,99 To / 2,88 To' });
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
    title: { en: 'Verify', fr: 'Vérification' },
    date: '2026-09-06T04:47:00.000Z',
    badge: { text: { en: 'Succeeded', fr: 'Réussie' }, color: 'success' },
  });
  assert.equal(cards[1].badge.color, 'warning');
  assert.deepEqual(cards[2], {
    title: { en: 'Prune', fr: 'Prune' },
    badge: { text: { en: 'Never run', fr: 'Jamais lancée' }, color: 'neutral' },
  });
});
