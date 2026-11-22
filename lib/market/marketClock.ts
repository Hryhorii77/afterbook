// NY cash-equity session clock. The whole product bet is "24/7 onchain vs
// 24/5 (and often less) cash market" — this has to be right, including
// holidays, or the tape shows a bogus gap.
//
// Source: NYSE 2026 holiday & early-closing calendar (ICE/NYSE Group press
// release), verified 2026-09-04.

export type SessionState = 'pre-market' | 'open' | 'after-hours' | 'closed-weekend' | 'closed-holiday' | 'closed-overnight';

// Full-day closures, YYYY-MM-DD in America/New_York.
const HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, July 4 falls on Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027 (NYSE calendar; added 2026-11-22 so the loan heads-up and the panel's line see New Year's Day)
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Day
  '2027-02-15', // Washington's Birthday
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed, June 19 falls on Saturday)
  '2027-07-05', // Independence Day (observed, July 4 falls on Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed, December 25 falls on Saturday)
]);
/** The last year the calendar above covers; past it the long-break check stays quiet rather than guess. */
const LAST_LISTED_YEAR = 2027;

// 1:00pm ET early closes.
const EARLY_CLOSE_2026 = new Set([
  '2026-11-27', // day after Thanksgiving
  '2026-12-24', // Christmas Eve
  '2027-11-26', // day after Thanksgiving
]);

interface NyClock {
  dateKey: string; // YYYY-MM-DD
  weekday: number; // 0=Sun..6=Sat
  minutesSinceMidnight: number;
}

function nyNow(now: Date): NyClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = Number(get('hour')) % 24; // formatToParts can emit "24" for midnight
  const minute = Number(get('minute'));
  const weekdayShort = get('weekday');
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    dateKey: `${year}-${month}-${day}`,
    weekday: weekdayMap[weekdayShort] ?? -1,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

export interface SessionInfo {
  state: SessionState;
  label: string;
  nyTime: string; // "HH:MM" in NY wall clock, for display
  dateKey: string;
  /** ISO instant of the next 9:30am NY open, for the "reopens" display. */
  nextOpenIso: string;
}

const PRE_MARKET_START = 4 * 60; // 4:00am
const OPEN_START = 9 * 60 + 30; // 9:30am
const OPEN_END = 16 * 60; // 4:00pm
const EARLY_CLOSE_END = 13 * 60; // 1:00pm

export function getSessionInfo(now: Date = new Date()): SessionInfo {
  const clock = nyNow(now);
  const hh = String(Math.floor(clock.minutesSinceMidnight / 60)).padStart(2, '0');
  const mm = String(clock.minutesSinceMidnight % 60).padStart(2, '0');
  const nyTime = `${hh}:${mm}`;

  const isWeekend = clock.weekday === 0 || clock.weekday === 6;
  const isHoliday = HOLIDAYS_2026.has(clock.dateKey);
  const isEarlyClose = EARLY_CLOSE_2026.has(clock.dateKey);
  const openEnd = isEarlyClose ? EARLY_CLOSE_END : OPEN_END;
  const nextOpenIso = getNextOpen(now).toISOString();

  if (isWeekend) {
    return { state: 'closed-weekend', label: 'Weekend — cash market closed', nyTime, dateKey: clock.dateKey, nextOpenIso };
  }
  if (isHoliday) {
    return { state: 'closed-holiday', label: 'Market holiday — cash market closed', nyTime, dateKey: clock.dateKey, nextOpenIso };
  }
  if (clock.minutesSinceMidnight < PRE_MARKET_START) {
    return { state: 'closed-overnight', label: 'Overnight — cash market closed', nyTime, dateKey: clock.dateKey, nextOpenIso };
  }
  if (clock.minutesSinceMidnight < OPEN_START) {
    return { state: 'pre-market', label: 'Pre-market', nyTime, dateKey: clock.dateKey, nextOpenIso };
  }
  if (clock.minutesSinceMidnight < openEnd) {
    return {
      state: 'open',
      label: isEarlyClose ? 'Open (early close 1:00pm ET)' : 'Cash market open',
      nyTime,
      dateKey: clock.dateKey,
      nextOpenIso,
    };
  }
  // After-hours runs four hours past the close: to 8 pm, or 5 pm after a 1 pm early close (owner review, 2026-11-22).
  if (clock.minutesSinceMidnight < openEnd + AFTER_HOURS_SPAN) {
    return { state: 'after-hours', label: 'After-hours', nyTime, dateKey: clock.dateKey, nextOpenIso };
  }
  return { state: 'closed-overnight', label: 'Overnight — cash market closed', nyTime, dateKey: clock.dateKey, nextOpenIso };
}

export function isCashMarketLive(state: SessionState): boolean {
  return state === 'open' || state === 'pre-market' || state === 'after-hours';
}

export function isTradingDay(dateKey: string, weekday: number): boolean {
  return weekday !== 0 && weekday !== 6 && !HOLIDAYS_2026.has(dateKey);
}

/** NY calendar-day key (YYYY-MM-DD) for a given instant — for grouping
 *  samples by trading day regardless of which UTC day they happen to fall
 *  on near midnight ET. */
export function nyDateKey(now: Date): string {
  return nyNow(now).dateKey;
}

// Finds the UTC instant for 9:30am America/New_York on a given NY calendar
// day, without a manual DST table: NY is always either UTC-4 (EDT) or UTC-5
// (EST), so try both candidate UTC instants and keep whichever one actually
// formats back to 09:30 in America/New_York for that date.
export function nyOpenInstant(dateKey: string): Date {
  for (const utcHour of [13, 14]) {
    const candidate = new Date(`${dateKey}T${String(utcHour).padStart(2, '0')}:30:00.000Z`);
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(candidate);
    if (formatted === '09:30') return candidate;
  }
  // Should be unreachable — fall back to the EDT guess.
  return new Date(`${dateKey}T13:30:00.000Z`);
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Next America/New_York 9:30am instant that's a trading day, scanning forward from `now`. */
export function getNextOpen(now: Date = new Date()): Date {
  const clock = nyNow(now);
  const todayIsTradingDay = isTradingDay(clock.dateKey, clock.weekday);
  const beforeOpenToday = clock.minutesSinceMidnight < OPEN_START;

  let candidateKey = todayIsTradingDay && beforeOpenToday ? clock.dateKey : addDaysToDateKey(clock.dateKey, 1);
  for (let i = 0; i < 10; i++) {
    const weekday = new Date(`${candidateKey}T12:00:00.000Z`).getUTCDay();
    if (isTradingDay(candidateKey, weekday)) return nyOpenInstant(candidateKey);
    candidateKey = addDaysToDateKey(candidateKey, 1);
  }
  return nyOpenInstant(candidateKey); // fallback, should not be reached
}

/** After-hours trading after a close (4 pm to 8 pm; 1 pm to 5 pm on an early-close day). */
const AFTER_HOURS_SPAN = 4 * 60;

/** The close (its NY date) that starts a long break, when `now` is inside that break: the market closed on a
 *  trading day and the next trading day is not the next calendar day (a weekend, a holiday, or both). null
 *  while the market is open or in pre-market, during the close day's after-hours, and on a plain weeknight. For the loan heads-up before such a
 *  break (2026-11-22): lending oracles follow the cash market, so a loan's oracle health can't move until the
 *  next open while Base's price keeps trading. */
export function longBreakClose(now: Date = new Date()): string | null {
  const session = getSessionInfo(now);
  if (session.state === 'open' || session.state === 'pre-market') return null;
  const clock = nyNow(now);
  if (Number(clock.dateKey.slice(0, 4)) > LAST_LISTED_YEAR) return null;
  const closeEnd = (key: string) => (EARLY_CLOSE_2026.has(key) ? EARLY_CLOSE_END : OPEN_END);
  // The last trading day whose session, after-hours included, has ended: today once after-hours is over (8 pm,
  // 5 pm after a 1 pm early close; owner review 2026-11-22), else the most recent one before today. On the close
  // day itself, before that, the stock still trades after hours: no break yet.
  let key = clock.dateKey;
  const weekdayOf = (k: string) => new Date(`${k}T12:00:00.000Z`).getUTCDay();
  if (isTradingDay(key, clock.weekday) && clock.minutesSinceMidnight >= closeEnd(key) && clock.minutesSinceMidnight < closeEnd(key) + AFTER_HOURS_SPAN) return null;
  if (!(isTradingDay(key, clock.weekday) && clock.minutesSinceMidnight >= closeEnd(key))) {
    key = addDaysToDateKey(key, -1);
    for (let i = 0; i < 10 && !isTradingDay(key, weekdayOf(key)); i++) key = addDaysToDateKey(key, -1);
  }
  const nextOpenKey = nyDateKey(getNextOpen(now));
  return nextOpenKey !== addDaysToDateKey(key, 1) ? key : null;
}

/** The weekday of the next open in New York ("Monday"), for "if Monday opens at Base's price". */
export function nextOpenWeekday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(getNextOpen(now));
}
