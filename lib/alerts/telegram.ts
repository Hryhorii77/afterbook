const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/** Like sendTelegramMessage, but says whether Telegram accepted it (for callers that only record what was sent). */
export async function sendTelegramMessageOk(chatId: string | number, text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 'sent'; 'refused' when Telegram says the message can never be delivered (403: the bot was blocked;
 *  400 "chat not found"); 'retry' for anything that may pass later (network, 429, 5xx, no token). */
export async function sendTelegramMessageStatus(chatId: string | number, text: string): Promise<'sent' | 'refused' | 'retry'> {
  if (!TELEGRAM_BOT_TOKEN) return 'retry';
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      // A hung request is a failed one (retried next run), never one that holds the cron past its limit.
      signal: AbortSignal.timeout(10_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (res.ok) return 'sent';
    if (res.status === 403) return 'refused';
    // Only a 400 for a chat that no longer exists is permanent; any other 400 (a message too long, say) is a
    // bug on our side that a fix can cure, so the alert is kept and tried again (review of #213).
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { description?: string } | null;
      return /chat not found/i.test(body?.description ?? '') ? 'refused' : 'retry';
    }
    return 'retry';
  } catch {
    return 'retry';
  }
}

/** No-ops (and logs, so it's visible in function logs) if the bot token
 *  isn't configured — same graceful-degradation posture as the Redis store
 *  everywhere else in this app. */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('sendTelegramMessage: TELEGRAM_BOT_TOKEN not configured');
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      // A hung send must not hold the webhook past its limit (Telegram would resend the update).
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best-effort — a dropped message just means the user doesn't get this
    // particular ping
  }
}
