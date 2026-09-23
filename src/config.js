export const MIN_POLL_FREQUENCY_SECONDS = 300;
export const MAX_POLL_FREQUENCY_SECONDS = 86_400;
export const DEFAULT_CONFIG = {
  node: 'localhost',
  poll_frequency: 900,
  verify_tls: true,
  date_format: 'iso',
  timezone: 'UTC',
};

/**
 * An IANA time zone name (`Europe/Paris`) as `Intl` accepts it, or UTC when the
 * value is empty or unknown, so a typo never breaks the refresh.
 */
export function normalizeTimeZone(value) {
  const zone = String(value ?? '').trim();
  if (!zone) return DEFAULT_CONFIG.timezone;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return DEFAULT_CONFIG.timezone;
  }
}

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
    timezone: normalizeTimeZone(source.timezone),
  };
}
