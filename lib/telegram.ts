const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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
