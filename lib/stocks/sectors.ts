// Each tracked stock's sector and Afterbook's theme tags, for the trade plan's "Describe a basket"
// mode (lib/agent/brief.ts). Hand-made, and checked against live sources on 2026-11-13: sectors follow
// GICS (the 11 standard sectors); themes are Afterbook's own fixed tags, so the code, never a model,
// decides which stocks fit a theme. Every stock in STOCKS needs an entry (tests/sectors.test.ts), so
// adding a token forces a decision here.

export const SECTORS = [
  'Information Technology',
  'Communication Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Health Care',
  'Financials',
  'Industrials',
  'Materials',
  'Energy',
  'Utilities',
  'Real Estate',
] as const;
export type Sector = (typeof SECTORS)[number];

export const THEMES = [
  'AI chips',
  'Memory & storage',
  'Software & cloud',
  'Internet & media',
  'Consumer tech',
  'EVs & autonomy',
  'Health care',
  'China',
  'Outside the US',
  'Bitcoin',
  'Space',
] as const;
export type Theme = (typeof THEMES)[number];

export interface StockProfile {
  sector: Sector;
  themes: Theme[];
  /** A fact worth saying next to the sector, when the label alone would mislead. */
  note?: string;
}

/** Keyed by onchain symbol (STOCKS[].symbol). */
export const PROFILES: Record<string, StockProfile> = {
  NVDAc: { sector: 'Information Technology', themes: ['AI chips'] },
  AAPLc: { sector: 'Information Technology', themes: ['Consumer tech'] },
  METAc: { sector: 'Communication Services', themes: ['Internet & media'] },
  GOOGLc: { sector: 'Communication Services', themes: ['Internet & media', 'Software & cloud'] },
  AMZNc: { sector: 'Consumer Discretionary', themes: ['Internet & media', 'Software & cloud'] },
  MSFTc: { sector: 'Information Technology', themes: ['Software & cloud'] },
  MSTRc: {
    sector: 'Information Technology',
    themes: ['Bitcoin'],
    note: 'Officially a software company; most of its value is the bitcoin it holds.',
  },
  SNDKc: { sector: 'Information Technology', themes: ['Memory & storage'] },
  // Listed on Nasdaq since 2026-06-12.
  SPCXc: { sector: 'Industrials', themes: ['Space'] },
  TSLAc: { sector: 'Consumer Discretionary', themes: ['EVs & autonomy'] },
  PLTRc: { sector: 'Information Technology', themes: ['Software & cloud'] },
  MUc: { sector: 'Information Technology', themes: ['Memory & storage', 'AI chips'] },
  NFLXc: { sector: 'Communication Services', themes: ['Internet & media'] },
  // Nasdaq-listed SK hynix shares (since 2026-07-13), each 1/10 of a Korean common share.
  SKHYc: { sector: 'Information Technology', themes: ['Memory & storage', 'AI chips', 'Outside the US'] },
  HIMSc: { sector: 'Health Care', themes: ['Health care'] },
  ORCLc: { sector: 'Information Technology', themes: ['Software & cloud'] },
  AMDc: { sector: 'Information Technology', themes: ['AI chips'] },
  AVGOc: { sector: 'Information Technology', themes: ['AI chips'] },
  LLYc: { sector: 'Health Care', themes: ['Health care'] },
  MRVLc: { sector: 'Information Technology', themes: ['AI chips'] },
  SONYc: { sector: 'Consumer Discretionary', themes: ['Consumer tech', 'Outside the US'] },
  BILIc: { sector: 'Communication Services', themes: ['Internet & media', 'China', 'Outside the US'] },
  SAPc: { sector: 'Information Technology', themes: ['Software & cloud', 'Outside the US'] },
  SANc: { sector: 'Financials', themes: ['Outside the US'] },
  NOKc: { sector: 'Information Technology', themes: ['Outside the US'] },
  PDDc: { sector: 'Consumer Discretionary', themes: ['Internet & media', 'China', 'Outside the US'] },
  LIc: { sector: 'Consumer Discretionary', themes: ['EVs & autonomy', 'China', 'Outside the US'] },
  BIDUc: { sector: 'Communication Services', themes: ['Internet & media', 'China', 'Outside the US'] },
  VALEc: { sector: 'Materials', themes: ['Outside the US'] },
  BUDc: { sector: 'Consumer Staples', themes: ['Outside the US'] },
  NIOc: { sector: 'Consumer Discretionary', themes: ['EVs & autonomy', 'China', 'Outside the US'] },
  ARMc: { sector: 'Information Technology', themes: ['AI chips', 'Outside the US'] },
  INFYc: { sector: 'Information Technology', themes: ['Software & cloud', 'Outside the US'] },
  ULc: { sector: 'Consumer Staples', themes: ['Outside the US'] },
  // Robotaxis; GICS puts it in Consumer Discretionary (Yahoo's "software" is another system).
  WRDc: { sector: 'Consumer Discretionary', themes: ['EVs & autonomy', 'China', 'Outside the US'] },
  NVOc: { sector: 'Health Care', themes: ['Health care', 'Outside the US'] },
  // Broadline retail since MSCI's August 2025 change (was gaming).
  SEc: { sector: 'Consumer Discretionary', themes: ['Internet & media', 'Outside the US'] },
  // Lidar: auto parts.
  HSAIc: { sector: 'Consumer Discretionary', themes: ['EVs & autonomy', 'China', 'Outside the US'] },
};

export function profileOf(symbol: string): StockProfile | undefined {
  return PROFILES[symbol];
}
