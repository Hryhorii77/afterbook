import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/baskets/guard', async (orig) => ({ ...(await orig<object>()), guardBasketRequest: async () => null }));
const enrollSignature = vi.fn();
const enroll = vi.fn();
vi.mock('@/lib/baskets/glider', () => ({ enrollSignature, enroll }));

const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const OWNER = '0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae';

describe('enrollment pause', () => {
  it('stage 1 refuses without asking Glider for a message', async () => {
    const { POST } = await import('@/app/api/baskets/enroll/signature/route');
    const res = await POST(req({ owner: OWNER }) as never);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/paused/);
    expect(enrollSignature).not.toHaveBeenCalled();
  });
  it('stage 2 refuses a signature without forwarding it', async () => {
    const { POST } = await import('@/app/api/baskets/enroll/route');
    const res = await POST(req({ owner: OWNER, accountIndex: '69', agentAccountId: 'eip155:0:0x' + '1'.repeat(40), flowId: 'f', signature: '0x12' }) as never);
    expect(res.status).toBe(503);
    expect(enroll).not.toHaveBeenCalled();
  });
});
