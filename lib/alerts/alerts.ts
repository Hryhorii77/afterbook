import { redis } from '../server/redis';

export type AlertType = 'basis' | 'close' | 'loan';

export interface AlertRule {
  id: string;
  type: AlertType;
  /** Required for 'basis' rules, unused for 'close'. */
  symbol?: string;
  /** Required for 'basis' rules — fires when |basisBp| crosses this. */
  thresholdBp?: number;
  /** Required for 'loan' rules: the public address whose Aave/Morpho stock loans are watched. */
  wallet?: string;
  /** Required for 'loan' rules: fires when the loan's health (at the oracle or at Aerodrome's price) drops below this. */
  thresholdHf?: number;
  /** Edge-trigger state: true = condition currently holds. Only fires a
   *  message on the false→true transition, not every tick while it holds. */
  active: boolean;
  /** 'loan' rules: reads of the wallet that failed in a row (a lender's oracle or the RPC), for the
   *  heads-up at LOAN_READ_FAIL_NOTICE; 0 or missing after a good read. */
  failedReads?: number;
}

export const MAX_RULES_PER_CHAT = 10;

/** A message that wasn't delivered doesn't count as sent: the rule keeps its old state, so the next tick
 *  tries again, instead of the alert being lost (review of #212). */
export function stateAfterSend(prevActive: boolean, nowActive: boolean, message: string | null, delivered: boolean): boolean {
  return message && !delivered ? prevActive : nowActive;
}

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

/** Every chat's rules in a few MGETs (200 keys each) instead of one GET per chat (the cron, 2026-11-22). A chat
 *  whose read failed is left out of the map, so the cron skips it this tick rather than reading it as empty. */
export async function getRulesMany(chatIds: string[]): Promise<Map<string, AlertRule[]>> {
  const out = new Map<string, AlertRule[]>();
  if (!redis || chatIds.length === 0) return out;
  for (let i = 0; i < chatIds.length; i += 200) {
    const ids = chatIds.slice(i, i + 200);
    try {
      const rows = await redis.mget<(AlertRule[] | null)[]>(...ids.map(chatKey));
      ids.forEach((id, j) => out.set(id, rows[j] ?? []));
    } catch {
      // this batch is skipped this tick
    }
  }
  return out;
}

/** The list started at `tick` (the cron passes a random start each run), so if a run ever stops at its time
 *  budget, it isn't always the same chats that are left unchecked. */
export function rotate<T>(list: T[], tick: number): T[] {
  if (list.length === 0) return list;
  const k = ((tick % list.length) + list.length) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
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

/** Free tier: one watched wallet per chat (more is the planned paid tier, Phase 2b step 2). */
export const MAX_LOAN_RULES_PER_CHAT = 1;
