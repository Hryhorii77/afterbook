// May this request spend a Claude call? Shared by the trade plan and the basket brief routes: every
// explained plan is billed, so both use the same per-person and daily limits (agentLimiter,
// agentDailyLimiter). Without Redis there is no cap that holds across instances, so no: the plan is
// then explained in fixed words.
import 'server-only';
import { agentLimiter, agentDailyLimiter } from '../server/ratelimit';
import { explainerConfigured } from './explain';

export function callerIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function mayExplain(request: Request): Promise<boolean> {
  if (!explainerConfigured()) return false;
  if (!agentLimiter || !agentDailyLimiter) return false;
  const mine = await agentLimiter.limit(callerIp(request));
  if (!mine.success) return false;
  return (await agentDailyLimiter.limit('all')).success;
}
