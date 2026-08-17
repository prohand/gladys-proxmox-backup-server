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

export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    base_url: String(raw.base_url ?? '').replace(/\/+$/, ''),
    api_token_id: String(raw.api_token_id ?? ''),
    api_token_secret: String(raw.api_token_secret ?? ''),
    node: String(raw.node ?? DEFAULT_CONFIG.node),
    poll_frequency: normalizePollFrequency(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    verify_tls: raw.verify_tls !== false,
    date_format: String(raw.date_format ?? DEFAULT_CONFIG.date_format).trim() || 'iso',
  };
}
