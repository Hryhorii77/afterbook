'use client';

// The trader's slippage limit, shared by every swap panel on the page and remembered in this browser
// (a convenience only: with storage blocked it is the 0.5% default). The server refuses anything
// outside MIN_SLIPPAGE_BPS..MAX_SLIPPAGE_BPS and builds and checks each swap with the value sent.

import { useState, useSyncExternalStore } from 'react';
import { MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, SLIPPAGE_BPS } from '@/lib/swap';

const KEY = 'afterbook-slippage-bps';
const PRESETS = [10, 50, 100];
const listeners = new Set<() => void>();
let current: number | null = null;

const inRange = (n: number) => Number.isInteger(n) && n >= MIN_SLIPPAGE_BPS && n <= MAX_SLIPPAGE_BPS;

function read(): number {
  if (current !== null) return current;
  try {
    const saved = Number(window.localStorage.getItem(KEY));
    current = inRange(saved) ? saved : SLIPPAGE_BPS;
  } catch {
    current = SLIPPAGE_BPS;
  }
  return current;
}

function write(bps: number) {
  if (!inRange(bps)) return;
  current = bps;
  try {
    window.localStorage.setItem(KEY, String(bps));
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The current slippage limit in bp (the default during server render). */
export function useSlippage(): number {
  return useSyncExternalStore(subscribe, read, () => SLIPPAGE_BPS);
}

const pct = (bps: number) => `${bps / 100}%`;

/** Chips for 0.1 / 0.5 / 1% and a custom percent box, under a panel's amount row. */
export function SlippageControl({ disabled }: { disabled?: boolean }) {
  const bps = useSlippage();
  const [custom, setCustom] = useState('');
  const customBps = custom === '' ? null : Math.round(Number(custom) * 100);
  const customBad = custom !== '' && (customBps === null || !Number.isFinite(customBps) || !inRange(customBps));

  return (
    <>
      <div className="slippage-row" role="group" aria-label="Maximum slippage">
        <span className="slippage-label">Max slippage</span>
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={p === bps && custom === '' ? 'preset-btn preset-btn-active' : 'preset-btn'}
            aria-pressed={p === bps && custom === ''}
            onClick={() => {
              setCustom('');
              write(p);
            }}
            disabled={disabled}
          >
            {pct(p)}
          </button>
        ))}
        <input
          className="slippage-custom"
          inputMode="decimal"
          aria-label="Custom maximum slippage, percent"
          placeholder={PRESETS.includes(bps) ? 'Other %' : `${bps / 100}%`}
          value={custom}
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9.]/g, '');
            if (!/^\d*\.?\d{0,2}$/.test(next)) return;
            setCustom(next);
            const n = Math.round(Number(next) * 100);
            if (next !== '' && inRange(n)) write(n);
          }}
          onBlur={() => customBad && setCustom('')}
          disabled={disabled}
        />
      </div>
      {customBad && (
        <p className="geo-note">
          Pick {pct(MIN_SLIPPAGE_BPS)} to {pct(MAX_SLIPPAGE_BPS)}. Still using {pct(bps)}.
        </p>
      )}
      {bps > SLIPPAGE_BPS && !customBad && (
        <p className="geo-note">
          At {pct(bps)} the swap still goes through if the price moves up to {pct(bps)} against you before it is mined, and bots can take part of that
          gap. Use it for a pool that keeps reverting at 0.5%.
        </p>
      )}
    </>
  );
}
