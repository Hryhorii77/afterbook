// Tiny price trend line for a table row: no axes, coloured by whether the last
// point is above the first, with a dot on the latest value.
export function MiniSpark({ values }: { values: number[] | undefined }) {
  if (!values || values.length < 2) return <span className="mini-spark-empty">—</span>;
  const W = 96;
  const H = 28;
  const PAD = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const up = values[values.length - 1] >= values[0];
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className={`mini-spark ${up ? 'mini-spark-up' : 'mini-spark-down'}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={up ? 'Price up over 24 hours' : 'Price down over 24 hours'}>
      <path d={d} fill="none" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2.6" />
    </svg>
  );
}
