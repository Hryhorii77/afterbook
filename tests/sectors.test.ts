import { describe, expect, it } from 'vitest';
import { STOCKS } from '../lib/stocks/tokens';
import { PROFILES, SECTORS, THEMES } from '../lib/stocks/sectors';

describe('stock sectors and themes', () => {
  it('every tracked stock has a profile, and nothing else does', () => {
    expect(Object.keys(PROFILES).sort()).toEqual(STOCKS.map((s) => s.symbol).sort());
  });
  it('uses only known sectors and themes, each stock with at least one theme and no repeats', () => {
    for (const [sym, p] of Object.entries(PROFILES)) {
      expect(SECTORS, sym).toContain(p.sector);
      expect(p.themes.length, sym).toBeGreaterThan(0);
      expect(new Set(p.themes).size, sym).toBe(p.themes.length);
      for (const t of p.themes) expect(THEMES, sym).toContain(t);
    }
  });
  it('every theme is used by some stock', () => {
    const used = new Set(Object.values(PROFILES).flatMap((p) => p.themes));
    for (const t of THEMES) expect(used.has(t), t).toBe(true);
  });
});
