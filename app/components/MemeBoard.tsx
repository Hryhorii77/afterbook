'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { SymbolTile } from './SymbolTile';
import type { MemeRow } from '@/lib/memestocks';
import { pctMove, usdOrDash } from '@/lib/memeFormat';

type Sort = 'volume' | 'move';

const moveClass = (n: number | null) => (n == null ? '' : n >= 0 ? 'meme-up' : 'meme-down');

function Rows({ rows }: { rows: MemeRow[] }) {
  return (
    <ul className="directory-list">
      {rows.map((r) => (
        <li key={r.pool.meme.address} className="directory-row meme-row">
          <Link href={`/memes/${r.pool.meme.address}`} className="directory-main">
            <SymbolTile cashTicker={r.pool.meme.symbol.slice(0, 5)} size="sm" iconUrl={null} />
            <span className="directory-name">
              <span className="directory-symbol">{r.pool.meme.symbol}</span>
              <span className="directory-company">on {r.pool.stockSymbol}</span>
            </span>
          </Link>
          <span className="meme-move">
            <span className={moveClass(r.move.h24)}>{pctMove(r.move.h24)}</span>
            <span className="directory-depth">
              {r.pool.stockSymbol} {pctMove(r.stockMove.h24)}
            </span>
          </span>
          <span className="meme-stats">
            <span>{usdOrDash(r.volume24Usd)} traded</span>
            <span className="directory-depth">{usdOrDash(r.liquidityUsd)} liquidity</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MemeBoard({ rows }: { rows: MemeRow[] }) {
  const [sort, setSort] = useState<Sort>('volume');
  const [showThin, setShowThin] = useState(false);

  const sorted = useMemo(() => {
    const by = sort === 'volume' ? (r: MemeRow) => r.volume24Usd ?? -1 : (r: MemeRow) => (r.move.h24 == null ? -1 : Math.abs(r.move.h24));
    return [...rows].sort((a, b) => by(b) - by(a));
  }, [rows, sort]);
  const liquid = sorted.filter((r) => !r.thin);
  const thin = sorted.filter((r) => r.thin);

  return (
    <>
      <div className="directory-controls">
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
          <option value="volume">Most traded in 24h</option>
          <option value="move">Biggest 24h move</option>
        </select>
      </div>
      <Rows rows={liquid} />
      {thin.length > 0 && (
        <div className="thin-books">
          <button className="thin-toggle" onClick={() => setShowThin((v) => !v)}>
            {showThin ? '▾' : '▸'} {showThin ? 'Hide' : 'Show'} {thin.length} thin pool{thin.length === 1 ? '' : 's'}
          </button>
          {showThin && (
            <>
              <p className="geo-note">Under $10k of liquidity: a single small trade moves these prices a lot.</p>
              <Rows rows={thin} />
            </>
          )}
        </div>
      )}
    </>
  );
}
