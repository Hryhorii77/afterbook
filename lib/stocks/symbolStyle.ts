// A hand-picked hue per underlying company, used to tint each symbol's tile.
// These are not logos: the tile shows the ticker text on a tinted background,
// so the app looks recognisably "per company" without using anyone's artwork.
const HUES: Record<string, string> = {
  NVDA: '#76b900',
  AAPL: '#a2aab8',
  META: '#1f7aff',
  GOOGL: '#ea4335',
  AMZN: '#ff9900',
  MSFT: '#00a4ef',
  MSTR: '#f7931a',
  SNDK: '#e8344a',
  SPCX: '#8b95a7',
  TSLA: '#e82127',
};

export const tileHue = (cashTicker: string): string => HUES[cashTicker] ?? '#9cd6ff';
