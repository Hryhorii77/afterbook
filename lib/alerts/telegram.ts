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

/** 'sent'; 'refused' when Telegram says the message can never be delivered (400/403: the bot was blocked,
 *  the chat is gone); 'retry' for anything that may pass later (network, 429, 5xx, no token). */
export async function sendTelegramMessageStatus(chatId: string | number, text: string): Promise<'sent' | 'refused' | 'retry'> {
  if (!TELEGRAM_BOT_TOKEN) return 'retry';
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (res.ok) return 'sent';
    return res.status === 400 || res.status === 403 ? 'refused' : 'retry';
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
    });
  } catch {
    // best-effort — a dropped message just means the user doesn't get this
    // particular ping
  }
}
