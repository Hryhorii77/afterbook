// The header every KyberSwap aggregator call sends. KyberSwap gives a registered integrator its own
// client id with its own rate limit (Afterbook's: 3 requests/s, offered by KyberSwap's team on
// 2026-11-12); before that every call sent the unregistered name 'afterbook' and ran on the keyless
// public tier. The id lives in KYBERSWAP_CLIENT_ID (Vercel Production, and the local env file) and is
// treated as a secret: it is only ever sent in this header, never logged, never put in a response,
// and never used as the build body's `source` (which stays 'afterbook'). Unset, calls fall back to the
// old name, so nothing breaks before it is configured.
export const KYBER_SOURCE = 'afterbook';

/** KyberSwap's error text is shown to the trader; if it ever quotes the client id (a rejected or
 *  rate-limited id is the likely case), the id is blanked out first. */
export function redactKyber(message: string): string {
  const id = process.env.KYBERSWAP_CLIENT_ID?.trim();
  return id ? message.split(id).join('[client id]') : message;
}

export function kyberHeaders(json = false): Record<string, string> {
  const id = process.env.KYBERSWAP_CLIENT_ID?.trim() || KYBER_SOURCE;
  return { 'x-client-id': id, ...(json ? { 'content-type': 'application/json' } : {}) };
}
