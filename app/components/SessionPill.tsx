// The "Cash market open · 14:35 ET" pill, shared by the Tape and Biggest gap
// heroes so the two can't drift apart: status dot, label, New York time.
export function SessionPill({ state, label, nyTime }: { state: string; label: string; nyTime: string }) {
  return (
    <span className="today-session">
      <span className={`dot ${state}`} />
      {label} · {nyTime} ET
    </span>
  );
}
