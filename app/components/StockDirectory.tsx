'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { SymbolTile } from './SymbolTile';
import { usdCompact } from '@/lib/format';
import { memePrice, pctMove } from '@/lib/memeFormat';
import type { DirectoryRow, DirectoryStatus } from '@/lib/stockDirectory';

type Filter = 'all' | DirectoryStatus;
type Sort = 'default' | 'volume' | 'onBase' | 'move' | 'memes';

const STATUS_LABEL: Record<DirectoryStatus, string> = {
  tracked: 'Tracked',
  pool: 'Small pool',
  none: 'No pool yet',
  unchecked: 'Not checked yet',
};
const PAGE = 25;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const moveClass = (n: number | null) => (n == null ? '' : n >= 0 ? 'meme-up' : 'meme-down');

function Memes({ row }: { row: DirectoryRow }) {
  if (row.memes.length === 0) return <span className="directory-dim">—</span>;
  const shown = row.memes.slice(0, 3);
  return (
    <Link href={`/memes?stock=${row.symbol}`} className="stock-memes" title={`${row.memes.length} meme${row.memes.length === 1 ? '' : 's'} priced in ${row.symbol}`}>
      {shown.map((m) => (
        <SymbolTile key={m.address} cashTicker={m.symbol.slice(0, 4)} size="sm" iconUrl={m.imageUrl} />
      ))}
      {row.memes.length > shown.length && <span className="stock-memes-more">+{row.memes.length - shown.length}</span>}
    </Link>
  );
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  );
}

export function StockDirectory({ rows }: { rows: DirectoryRow[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('default');
  const [page, setPage] = useState(0);

  const counts = useMemo(() => {
    const c: Record<DirectoryStatus, number> = { tracked: 0, pool: 0, none: 0, unchecked: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => (filter === 'all' || r.status === filter) && (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)));
    const key: Record<Exclude<Sort, 'default'>, (r: DirectoryRow) => number> = {
      volume: (r) => r.volume24Usd ?? -1,
      onBase: (r) => r.onBaseUsd ?? -1,
      move: (r) => (r.change24Pct == null ? -1 : Math.abs(r.change24Pct)),
      memes: (r) => r.memes.length,
    };
    return sort === 'default' ? list : [...list].sort((a, b) => key[sort](b) - key[sort](a));
  }, [rows, query, filter, sort]);

  // Back to the first page whenever what is listed changes.
  useEffect(() => setPage(0), [query, filter, sort]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const slice = shown.slice(page * PAGE, page * PAGE + PAGE);

  return (
    <>
      <div className="directory-controls">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a ticker or company"
          aria-label="Search a ticker or company"
          autoComplete="off"
          spellCheck={false}
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Show">
          <option value="all">All ({rows.length})</option>
          {(['tracked', 'pool', 'none', 'unchecked'] as const)
            .filter((s) => counts[s] > 0)
            .map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]} ({counts[s]})
              </option>
            ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
          <option value="default">Tracked first</option>
          <option value="volume">Most traded in 24h</option>
          <option value="onBase">Most value on Base</option>
          <option value="move">Biggest 24h move</option>
          <option value="memes">Most memes</option>
        </select>
      </div>

      {shown.length === 0 ? (
        <p className="geo-note">No tokenized stock matches &ldquo;{query}&rdquo;.</p>
      ) : (
        <>
          <div className="stock-table-head" aria-hidden="true">
            <span>Stock</span>
            <span>Price on Base</span>
            <span>24h</span>
            <span>Traded 24h</span>
            <span>On Base</span>
            <span>Memes</span>
            <span>Aerodrome pool</span>
          </div>
          <ul className="directory-list">
            {slice.map((r) => {
              const ticker = r.symbol.replace(/c$/, '');
              const name = (
                <>
                  <SymbolTile cashTicker={ticker} size="sm" iconUrl={r.iconUrl} />
                  <span className="directory-name">
                    <span className="directory-symbol">{r.symbol}</span>
                    <span className="directory-company">{r.name || ticker}</span>
                  </span>
                </>
              );
              return (
                <li key={r.symbol} className="directory-row stock-row">
                  {r.status === 'tracked' ? (
                    <Link href={`/${r.symbol}`} className="directory-main">
                      {name}
                    </Link>
                  ) : (
                    <span className="directory-main">{name}</span>
                  )}
                  <span className="stock-cell stock-price" data-label="Price">{memePrice(r.priceUsd)}</span>
                  <span className={`stock-cell ${moveClass(r.change24Pct)}`} data-label="24h">{pctMove(r.change24Pct)}</span>
                  <span className="stock-cell" data-label="Traded 24h">{r.volume24Usd == null ? '—' : usdCompact(r.volume24Usd)}</span>
                  <span className="stock-cell" data-label="On Base">{r.onBaseUsd == null ? '—' : usdCompact(r.onBaseUsd)}</span>
                  <span className="stock-cell" data-label="Memes"><Memes row={r} /></span>
                  <span className={`stock-cell directory-status directory-status-${r.status}`} data-label="Pool">
                    {STATUS_LABEL[r.status]}
                    {(r.status === 'tracked' || r.status === 'pool') && (
                      <span className="directory-depth">{r.depthUsd != null ? `${usdCompact(r.depthUsd)} deep` : 'depth unreadable'}</span>
                    )}
                    <a className="directory-contract" href={`https://basescan.org/token/${r.tokenAddress}`} target="_blank" rel="noopener noreferrer">
                      {short(r.tokenAddress)}&nbsp;↗
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <nav className="stock-pager" aria-label="Pages">
              <button type="button" className="theme-toggle" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page">
                <Chevron dir="left" />
              </button>
              <span>
                Page {page + 1} of {pages}
              </span>
              <button type="button" className="theme-toggle" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} aria-label="Next page">
                <Chevron dir="right" />
              </button>
            </nav>
          )}
        </>
      )}
    </>
  );
}
