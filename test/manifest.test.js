import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
  assert.ok(
    manifest.config_schema.some(
      ({ key, type, default: defaultValue }) =>
        key === 'date_format' && type === 'string' && defaultValue === 'iso',
    ),
  );
});
