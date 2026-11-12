import { afterEach, describe, expect, it, vi } from 'vitest';
import { KYBER_SOURCE, kyberHeaders, redactKyber } from '../lib/swap/kyberClient';

describe('kyberHeaders', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('falls back to the public name when no client id is set', () => {
    vi.stubEnv('KYBERSWAP_CLIENT_ID', '');
    expect(kyberHeaders()).toEqual({ 'x-client-id': 'afterbook' });
    vi.stubEnv('KYBERSWAP_CLIENT_ID', '   ');
    expect(kyberHeaders()['x-client-id']).toBe('afterbook');
  });
  it('sends the registered id, trimmed, and JSON only for a body', () => {
    vi.stubEnv('KYBERSWAP_CLIENT_ID', '  test-id-123 \n');
    expect(kyberHeaders()).toEqual({ 'x-client-id': 'test-id-123' });
    expect(kyberHeaders(true)).toEqual({ 'x-client-id': 'test-id-123', 'content-type': 'application/json' });
  });
  it('blanks the id out of KyberSwap error text', () => {
    vi.stubEnv('KYBERSWAP_CLIENT_ID', 'test-id-123');
    expect(redactKyber('invalid client id test-id-123 (test-id-123)')).toBe('invalid client id [client id] ([client id])');
    vi.stubEnv('KYBERSWAP_CLIENT_ID', '');
    expect(redactKyber('route not found')).toBe('route not found');
  });
  it('never uses the id as the build source', () => {
    expect(KYBER_SOURCE).toBe('afterbook');
  });
});
