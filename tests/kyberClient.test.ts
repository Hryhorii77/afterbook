import { afterEach, describe, expect, it, vi } from 'vitest';
import { KYBER_GATEWAY, KYBER_PUBLIC, KYBER_SOURCE, kyberBase, kyberHeaders, logKyberFailure, redactKyber } from '../lib/swap/kyberClient';

describe('KyberSwap client', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('without a key: the public host and x-client-id afterbook', () => {
    for (const v of ['', '   ']) {
      vi.stubEnv('KYBERSWAP_API_KEY', v);
      expect(kyberBase()).toBe(KYBER_PUBLIC);
      expect(kyberBase()).toBe('https://aggregator-api.kyberswap.com/base/api/v1');
      expect(kyberHeaders()).toEqual({ 'x-client-id': 'afterbook' });
    }
  });

  it('with a key: the gateway and only x-api-key, trimmed; JSON only for a body', () => {
    vi.stubEnv('KYBERSWAP_API_KEY', '  test-key-123 \n');
    expect(kyberBase()).toBe(KYBER_GATEWAY);
    expect(kyberBase()).toBe('https://api.kyberswap.com/swap/base/api/v1');
    expect(kyberHeaders()).toEqual({ 'x-api-key': 'test-key-123' });
    expect(kyberHeaders(true)).toEqual({ 'x-api-key': 'test-key-123', 'content-type': 'application/json' });
    expect(kyberHeaders()).not.toHaveProperty('x-client-id');
  });

  it('blanks the key out of KyberSwap error text', () => {
    vi.stubEnv('KYBERSWAP_API_KEY', 'test-key-123');
    expect(redactKyber('invalid api key test-key-123 (test-key-123)')).toBe('invalid api key [api key] ([api key])');
    vi.stubEnv('KYBERSWAP_API_KEY', '');
    expect(redactKyber('route not found')).toBe('route not found');
  });

  it('never uses the key as the build source', () => {
    vi.stubEnv('KYBERSWAP_API_KEY', 'test-key-123');
    expect(KYBER_SOURCE).toBe('afterbook');
  });
});

describe('logKyberFailure', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('logs the full path and status for auth, path and rate-limit failures, never the key or query', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('KYBERSWAP_API_KEY', 'test-key-123');
    logKyberFailure(401, '/routes?tokenIn=0xabc&amountIn=1');
    expect(err).toHaveBeenCalledWith('kyberswap: 401 from api.kyberswap.com/swap/base/api/v1/routes');
    vi.stubEnv('KYBERSWAP_API_KEY', '');
    logKyberFailure(429, '/route/build');
    expect(err).toHaveBeenLastCalledWith('kyberswap: 429 from aggregator-api.kyberswap.com/base/api/v1/route/build');
    expect(err.mock.calls.flat().join(' ')).not.toContain('test-key-123');
  });
  it('stays quiet on ordinary answers', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const s of [200, 400, 422, 500]) logKyberFailure(s, '/routes');
    expect(err).not.toHaveBeenCalled();
  });
});
