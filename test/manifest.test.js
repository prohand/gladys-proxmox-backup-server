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
});

