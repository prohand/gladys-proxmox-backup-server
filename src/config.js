export const DEFAULT_CONFIG = { node: 'localhost', poll_frequency: 300, verify_tls: true };

export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    base_url: String(raw.base_url ?? '').replace(/\/+$/, ''),
    api_token_id: String(raw.api_token_id ?? ''),
    api_token_secret: String(raw.api_token_secret ?? ''),
    node: String(raw.node ?? DEFAULT_CONFIG.node),
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    verify_tls: raw.verify_tls !== false,
  };
}
