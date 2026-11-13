// Reads a number typed into the trade plan's forms (/plan: budget, the % limits, cash to keep).
// The inputs strip everything but digits and dots, which still lets through "", "1.2.3" or ".":
// Number() made those 0 or NaN, and NaN went out as null, which the server reads as "not given" and
// replaces with its default limit, so a typo silently became a different limit (review of PR #171,
// 2026-11-13). This says what is wrong instead.

const PLAIN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** The number, or a message naming the field. `emptyAs` lets an optional field be left blank. */
export function readNumberField(raw: string, label: string, emptyAs?: number): number | string {
  const t = raw.trim();
  if (t === '' && emptyAs !== undefined) return emptyAs;
  if (!PLAIN.test(t)) return t === '' ? `${label} is empty` : `${label} isn’t a number`;
  return Number(t);
}

/** Reads several fields; the first problem, or every value. */
export function readNumberFields<K extends string>(fields: Record<K, [raw: string, label: string, emptyAs?: number]>): { values: Record<K, number> } | { error: string } {
  const values = {} as Record<K, number>;
  for (const key of Object.keys(fields) as K[]) {
    const [raw, label, emptyAs] = fields[key];
    const v = readNumberField(raw, label, emptyAs);
    if (typeof v === 'string') return { error: v };
    values[key] = v;
  }
  return { values };
}
