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
