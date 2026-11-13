// Reads a number typed into the trade plan's forms (/plan: budget, the % limits, cash to keep).
// The inputs strip everything but digits and dots (in a % box a comma becomes a dot first, so "1,5" is 1.5, not
// 15), which still lets through "", "1.2.3" or ".": Number() made those 0 or NaN, and NaN went out as
// null, which the server read as "not given" and replaced with its default limit, so a typo silently
// became a different limit (review of PR #171, 2026-11-13). A number of 310+ digits is Infinity, also
// sent as null (review of PR #173). This says what is wrong instead.

const PLAIN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** A dollar box (the budget): commas are thousands and dropped, so "25,000" is 25000, as in the basket
 *  buy's own amount box. Reading them as a point made "25,000" a $25 basket (review of PR #173). */
export const cleanAmountInput = (raw: string) => raw.replace(/[^0-9.]/g, '');

/** A % box: nobody writes thousands there, so a comma is a decimal comma: "1,5" is 1.5, not 15. */
export const cleanPercentInput = (raw: string) => raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');

/** The number, or a message naming the field. `emptyAs` lets an optional field be left blank. */
export function readNumberField(raw: string, label: string, emptyAs?: number): number | string {
  const t = raw.trim();
  if (t === '' && emptyAs !== undefined) return emptyAs;
  if (t === '') return `${label} is empty`;
  const n = Number(t);
  if (!PLAIN.test(t) || !Number.isFinite(n)) return `${label} isn’t a number`;
  return n;
}

/** Reads several fields; the first problem (with its field's key, to focus it), or every value. */
export function readNumberFields<K extends string>(
  fields: Record<K, [raw: string, label: string, emptyAs?: number]>,
): { values: Record<K, number> } | { error: string; field: K } {
  const values = {} as Record<K, number>;
  for (const key of Object.keys(fields) as K[]) {
    const [raw, label, emptyAs] = fields[key];
    const v = readNumberField(raw, label, emptyAs);
    if (typeof v === 'string') return { error: v, field: key };
    values[key] = v;
  }
  return { values };
}
