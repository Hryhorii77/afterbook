import 'server-only';

// Where every KyberSwap aggregator call goes, and with which header. KyberSwap's team (2026-11-12) gave
// Afterbook an API key for their keyed gateway (higher rate limits; "client-id whitelisting is no longer
// offered", per their docs). With KYBERSWAP_API_KEY set, calls go to the gateway with only `x-api-key`;
// unset, they keep the old keyless public host with `x-client-id: afterbook` (3 requests/s), so nothing
// breaks before the variable exists. The key is a secret: only ever sent in that header, never logged,
// never in a response (redactKyber), never NEXT_PUBLIC, and never the build body's `source` (which stays
// 'afterbook' and may be written into public calldata). Server-only, so none of this reaches a browser.
export const KYBER_SOURCE = 'afterbook';
export const KYBER_GATEWAY = 'https://api.kyberswap.com/swap/base/api/v1';
export const KYBER_PUBLIC = 'https://aggregator-api.kyberswap.com/base/api/v1';

const apiKey = () => process.env.KYBERSWAP_API_KEY?.trim() || '';

/** The aggregator's base URL for Base: the keyed gateway when a key is set, else the public host. */
export function kyberBase(): string {
  return apiKey() ? KYBER_GATEWAY : KYBER_PUBLIC;
}

export function kyberHeaders(json = false): Record<string, string> {
  const key = apiKey();
  return { ...(key ? { 'x-api-key': key } : { 'x-client-id': KYBER_SOURCE }), ...(json ? { 'content-type': 'application/json' } : {}) };
}

/** KyberSwap's error text is shown to the trader; if it ever quotes the key (a rejected or rate-limited
 *  key is the likely case), it is blanked out first. */
export function redactKyber(message: string): string {
  const key = apiKey();
  return key ? message.split(key).join('[api key]') : message;
}
