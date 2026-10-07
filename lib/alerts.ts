import { redis } from './redis';

export type AlertType = 'basis' | 'close';

export interface AlertRule {
  id: string;
  type: AlertType;
  /** Required for 'basis' rules, unused for 'close'. */
  symbol?: string;
  /** Required for 'basis' rules — fires when |basisBp| crosses this. */
  thresholdBp?: number;
  /** Edge-trigger state: true = condition currently holds. Only fires a
   *  message on the false→true transition, not every tick while it holds. */
  active: boolean;
}

export const MAX_RULES_PER_CHAT = 10;

/** After a basis alert fires it re-arms only once |basis| falls back to this share of the level or
 *  lower (50 bp alert -> back to 40 bp or lower). Without it a gap hovering around the level sent one message
 *  per wiggle across the line (a public screenshot showed NVDAc alerting about 14 times in a day
 *  and a half). */
export const REARM_RATIO = 0.8;

/** Next edge-trigger state of a basis rule. `absBp` is null when the tape has no reading: the
 *  state is kept, so a data blip can't re-arm the alert. */
export function nextBasisState(active: boolean, absBp: number | null, thresholdBp: number): boolean {
  if (absBp == null) return active;
  return active ? absBp > thresholdBp * REARM_RATIO : absBp > thresholdBp;
}
const CHATS_KEY = 'alerts:chats';
const chatKey = (chatId: string) => `alerts:chat:${chatId}`;

export async function getRules(chatId: string): Promise<AlertRule[]> {
  if (!redis) return [];
  try {
    const raw = await redis.get<AlertRule[]>(chatKey(chatId));
    return raw ?? [];
  } catch {
    return [];
  }
}

export async function setRules(chatId: string, rules: AlertRule[]): Promise<void> {
  if (!redis) return;
  try {
    if (rules.length === 0) {
      await Promise.all([redis.del(chatKey(chatId)), redis.srem(CHATS_KEY, chatId)]);
    } else {
      await Promise.all([redis.set(chatKey(chatId), rules), redis.sadd(CHATS_KEY, chatId)]);
    }
  } catch {
    // best-effort — a dropped write just means this chat's rules are stale
    // until the next successful one
  }
}

export async function getAllChatIds(): Promise<string[]> {
  if (!redis) return [];
  try {
    return await redis.smembers(CHATS_KEY);
  } catch {
    return [];
  }
}

export function canAddRule(rules: AlertRule[]): boolean {
  return rules.length < MAX_RULES_PER_CHAT;
}
