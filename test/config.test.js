import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CONFIG,
  MAX_POLL_FREQUENCY_SECONDS,
  MIN_POLL_FREQUENCY_SECONDS,
  normalizeConfig,
} from '../src/config.js';

test('normalizes URL and form values', () => {
  assert.deepEqual(
    normalizeConfig({ base_url: 'https://pbs:8007///', poll_frequency: '60', verify_tls: false }),
    {
      node: 'localhost',
      poll_frequency: MIN_POLL_FREQUENCY_SECONDS,
      verify_tls: false,
      base_url: 'https://pbs:8007',
      api_token_id: '',
      api_token_secret: '',
    },
  );
});

test('keeps the refresh interval within database-safe limits', () => {
  assert.equal(DEFAULT_CONFIG.poll_frequency, 900);
  assert.equal(normalizeConfig({ poll_frequency: 1200 }).poll_frequency, 1200);
  assert.equal(normalizeConfig({ poll_frequency: 'invalid' }).poll_frequency, 900);
  assert.equal(
    normalizeConfig({ poll_frequency: 100_000 }).poll_frequency,
    MAX_POLL_FREQUENCY_SECONDS,
  );
});
