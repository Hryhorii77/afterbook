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
]);

// 1:00pm ET early closes.
const EARLY_CLOSE_2026 = new Set([
  '2026-11-27', // day after Thanksgiving
  '2026-12-24', // Christmas Eve
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
const AFTER_HOURS_END = 20 * 60; // 8:00pm
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
  if (clock.minutesSinceMidnight < AFTER_HOURS_END) {
    return { state: 'after-hours', label: 'After-hours', nyTime, dateKey: clock.dateKey, nextOpenIso };
  }
  return { state: 'closed-overnight', label: 'Overnight — cash market closed', nyTime, dateKey: clock.dateKey, nextOpenIso };
}

export function isCashMarketLive(state: SessionState): boolean {
  return state === 'open' || state === 'pre-market' || state === 'after-hours';
}

function isTradingDay(dateKey: string, weekday: number): boolean {
  return weekday !== 0 && weekday !== 6 && !HOLIDAYS_2026.has(dateKey);
}

// Finds the UTC instant for 9:30am America/New_York on a given NY calendar
// day, without a manual DST table: NY is always either UTC-4 (EDT) or UTC-5
// (EST), so try both candidate UTC instants and keep whichever one actually
// formats back to 09:30 in America/New_York for that date.
function nyOpenInstant(dateKey: string): Date {
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
