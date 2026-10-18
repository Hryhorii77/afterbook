'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { SymbolTile } from './SymbolTile';
import { usdCompact } from '@/lib/format';
import type { DirectoryRow, DirectoryStatus } from '@/lib/stockDirectory';

type Filter = 'all' | DirectoryStatus;

const STATUS_LABEL: Record<DirectoryStatus, string> = {
  tracked: 'Tracked',
  pool: 'Small pool',
  none: 'No pool yet',
  unchecked: 'Not checked yet',
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function StockDirectory({ rows }: { rows: DirectoryRow[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const c: Record<DirectoryStatus, number> = { tracked: 0, pool: 0, none: 0, unchecked: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) => (filter === 'all' || r.status === filter) && (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)),
    );
  }, [rows, query, filter]);

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
      </div>

      {shown.length === 0 ? (
        <p className="geo-note">No tokenized stock matches &ldquo;{query}&rdquo;.</p>
      ) : (
        <ul className="directory-list">
          {shown.map((r) => {
            const ticker = r.symbol.replace(/c$/, '');
            const body = (
              <>
                <SymbolTile cashTicker={ticker} size="sm" iconUrl={r.iconUrl} />
                <span className="directory-name">
                  <span className="directory-symbol">{r.symbol}</span>
                  <span className="directory-company">{r.name || ticker}</span>
                </span>
              </>
            );
            return (
              <li key={r.symbol} className="directory-row">
                {r.status === 'tracked' ? (
                  <Link href={`/${r.symbol}`} className="directory-main">
                    {body}
                  </Link>
                ) : (
                  <span className="directory-main">{body}</span>
                )}
                <span className={`directory-status directory-status-${r.status}`}>
                  {STATUS_LABEL[r.status]}
                  {(r.status === 'tracked' || r.status === 'pool') && (
                    <span className="directory-depth">{r.depthUsd != null ? `${usdCompact(r.depthUsd)} deep` : 'depth unreadable'}</span>
                  )}
                </span>
                <a className="directory-contract" href={`https://basescan.org/token/${r.tokenAddress}`} target="_blank" rel="noopener noreferrer">
                  {short(r.tokenAddress)}&nbsp;↗
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
