// Shared between server code (e.g. app/api/cron/alerts) and
// app/components/HomeClient.tsx — kept framework-agnostic (no 'use client')
// so server routes can import it without pulling in client-component
// context.
export const bp = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)} bp`);
