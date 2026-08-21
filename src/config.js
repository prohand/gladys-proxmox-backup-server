export const MIN_POLL_FREQUENCY_SECONDS = 300;
export const MAX_POLL_FREQUENCY_SECONDS = 86_400;
export const DEFAULT_CONFIG = {
  node: 'localhost',
  poll_frequency: 900,
  verify_tls: true,
  date_format: 'iso',
};

function normalizePollFrequency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.poll_frequency;
  return Math.min(
    MAX_POLL_FREQUENCY_SECONDS,
    Math.max(MIN_POLL_FREQUENCY_SECONDS, Math.round(parsed)),
  );
}

/**
 * Build the runtime config from the raw manifest values. Only the keys declared
 * in the manifest are kept: anything else Gladys sends is dropped instead of
 * leaking into the config object.
 */
export function normalizeConfig(raw = {}) {
  const source = raw ?? {};
  return {
    base_url: String(source.base_url ?? '').replace(/\/+$/, ''),
    api_token_id: String(source.api_token_id ?? ''),
    api_token_secret: String(source.api_token_secret ?? ''),
    node: String(source.node ?? DEFAULT_CONFIG.node).trim() || DEFAULT_CONFIG.node,
    poll_frequency: normalizePollFrequency(source.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    verify_tls: source.verify_tls !== false,
    date_format: String(source.date_format ?? DEFAULT_CONFIG.date_format).trim() || 'iso',
  };
}
