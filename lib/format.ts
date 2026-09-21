// Shared between server code (e.g. app/api/cron/alerts) and
// app/components/HomeClient.tsx — kept framework-agnostic (no 'use client')
// so server routes can import it without pulling in client-component
// context.
export const bp = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)} bp`);

// Fee-APR window durations range from a fraction of an hour (the getLogs
// cold-start estimate, lib/feeApr.ts) up to several days (the real
// feeGrowthGlobal snapshot delta) — "0.0d" for the former reads as broken,
// so render sub-day windows in hours instead.
export const formatWindow = (days: number) => (days < 1 ? `${(days * 24).toFixed(1)}h` : `${days.toFixed(1)}d`);
