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

export const usd = (n: number | null, digits = 2) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

export const usdCompact = (n: number | null) => {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatNextOpen(iso: string): string {
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso)) + ' ET'
  );
}
