import { afterAll, describe, expect, it, vi } from 'vitest';

// Which Telegram failures end an alert's retries: only a blocked bot (403) or a chat that no longer exists
// (400 "chat not found"). Any other 400 is our bug, so the alert is kept and retried. fetch is a fake.
vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
const reply = (status: number, description?: string) =>
  vi.fn(async () => new Response(JSON.stringify({ ok: status === 200, description }), { status }));

describe('sendTelegramMessageStatus', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('sorts Telegram’s answers into sent, refused for good, and retry', async () => {
    const { sendTelegramMessageStatus } = await import('../lib/alerts/telegram');
    const cases: [number, string | undefined, string][] = [
      [200, undefined, 'sent'],
      [403, 'Forbidden: bot was blocked by the user', 'refused'],
      [400, 'Bad Request: chat not found', 'refused'],
      [400, 'Bad Request: message is too long', 'retry'],
      [429, 'Too Many Requests: retry after 5', 'retry'],
      [502, undefined, 'retry'],
    ];
    for (const [status, description, want] of cases) {
      vi.stubGlobal('fetch', reply(status, description));
      expect(await sendTelegramMessageStatus(1, 'x')).toBe(want);
    }
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
    expect(await sendTelegramMessageStatus(1, 'x')).toBe('retry');
  });
});
