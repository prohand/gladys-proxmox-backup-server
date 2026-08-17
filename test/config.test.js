import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../src/config.js';

test('normalizes URL and form values', () => {
  assert.deepEqual(
    normalizeConfig({ base_url: 'https://pbs:8007///', poll_frequency: '60', verify_tls: false }),
    {
      node: 'localhost',
      poll_frequency: 60,
      verify_tls: false,
      base_url: 'https://pbs:8007',
      api_token_id: '',
      api_token_secret: '',
    },
  );
});
