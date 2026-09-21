'use client';

import { useEffect, useState } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { formatWindow } from '@/lib/format';

interface SpotHolding {
  symbol: string;
  shares: number;
  usdValue: number;
}

interface LpHolding {
  symbol: string;
  usdcAmount: number;
  shares: number;
  usdValue: number;
  tickLower: number;
  tickUpper: number;
  inRange: boolean | null;
  rangeLowUsd: number;
  rangeHighUsd: number;
  feesEarnedUsd: number;
  emissionsEarnedAero: number;
  lockedUntil: number | null;
  currentPriceUsd: number | null;
  feeAprPct: number | null;
  feeAprWindowDays: number | null;
  feeAprEstimated: boolean;
  inRangeProbabilityPct: number | null;
  inRangeHorizonDays: number | null;
  gaugeAprPct: number | null;
  stakedRatioPct: number | null;
  isStaked: boolean;
  votingIncentiveFlag: {
    bribesUsd: number;
    hasUnpricedBribes: boolean;
    feesUsd: number;
    outpacing: boolean;
  } | null;
}

interface MyLotsResponse {
  spot: SpotHolding[];
  lp: LpHolding[];
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const shares = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
const lockDate = (ms: number) => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms));

// Price-range bar, not a tick-number axis — this app never surfaces raw
// tick numbers anywhere, the range is already shown in USD above this.
function RangeBar({ low, high, current }: { low: number; high: number; current: number | null }) {
  if (current == null || high <= low) return null;
  const pct = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100));
  const outOfRange = current < low || current > high;
  return (
    <div className="range-bar-track">
      <div className={`range-bar-marker${outOfRange ? ' range-bar-marker-out' : ''}`} style={{ left: `${pct}%` }} />
    </div>
  );
}

export function MyLots() {
  // wagmi/RainbowKit own the actual connection (which wallet, which
  // account, the picker modal, reconnect-on-reload) — this component just
  // reacts to the resulting address, same as it reacted to its own local
  // address state before.
  const { address: connectedAddress } = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const address = connectedAddress ?? null;

  // wagmi's disconnect() only clears its own connection state — for an
  // injected connector (MetaMask, Rabby, etc.) the extension itself still
  // considers this site authorized, so the next Connect would silently
  // reuse the same account with no way to pick a different one within that
  // wallet (this was a real, previously-shipped bug — see git history).
  // wallet_revokePermissions is the actual revoke call; wrapped in a no-op
  // catch since non-MetaMask providers may not implement it, and wagmi's
  // own disconnect() below still runs either way.
  const handleDisconnect = () => {
    window.ethereum?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    disconnect();
  };
  const [lots, setLots] = useState<MyLotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [basename, setBasename] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setLots(null);
      return;
    }
    let cancelled = false;
    setError(null);
    fetch(`/api/lots?address=${address}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          return;
        }
        setLots(json);
      })
      .catch(() => {
        if (!cancelled) setError('lots unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    if (!address) {
      setBasename(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/basename?address=${address}`)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setBasename(json.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setBasename(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return (
    <section className="panel">
      <h2>My Lots</h2>

      {!address ? (
        <>
          <p className="geo-note" style={{ marginTop: 0, marginBottom: 12 }}>
            Read-only — connecting only reveals your address so balances can be read. Never signs a transaction.
          </p>
          <button type="button" className="btn btn-secondary" onClick={openConnectModal} disabled={!openConnectModal}>
            Connect wallet
          </button>
        </>
      ) : (
        <>
          <div className="my-lots-header">
            <span className="my-lots-address">{basename ?? `${address.slice(0, 6)}…${address.slice(-4)}`}</span>
            <button type="button" className="copy-trade-btn" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>

          {error && <p className="geo-note">{error}</p>}

          {lots && lots.spot.length === 0 && lots.lp.length === 0 && !error && (
            <p className="geo-note">No holdings found across these ten stocks or their Aero pools.</p>
          )}

          {lots && lots.spot.length > 0 && (
            <>
              <p className="geo-note" style={{ marginTop: 0 }}>
                Spot
              </p>
              <div className="result-grid">
                {lots.spot.map((h) => (
                  <div className="result-cell" key={h.symbol}>
                    <div className="label">{h.symbol}</div>
                    <div className="value">{shares(h.shares)} sh</div>
                    <div className="my-lots-usd">{usd(h.usdValue)}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {lots && lots.lp.length > 0 && (
            <>
              <p className="geo-note">Aerodrome LP</p>
              <p className="geo-note" style={{ marginTop: 0 }}>
                Fee APR and in-range odds below are estimates from on-chain fee-growth snapshots and recent price
                volatility — not guarantees. Both need a day or two of collected data after a pool starts being
                tracked.
              </p>
              <div className="result-grid">
                {lots.lp.map((h) => (
                  <div className="result-cell" key={h.symbol}>
                    <div className="label">{h.symbol}</div>
                    <div className="value">
                      {usd(h.usdcAmount)} + {shares(h.shares)} sh
                    </div>
                    <div className="my-lots-usd">{usd(h.usdValue)}</div>
                    {h.inRange != null && (
                      <div className="geo-note">
                        <span className={h.inRange ? 'basis-pos' : 'basis-neg'}>{h.inRange ? 'In range' : 'Out of range'}</span>{' '}
                        {usd(h.rangeLowUsd)} – {usd(h.rangeHighUsd)}
                      </div>
                    )}
                    <RangeBar low={h.rangeLowUsd} high={h.rangeHighUsd} current={h.currentPriceUsd} />
                    {h.feeAprPct != null ? (
                      <div className="geo-note">
                        Fee APR ≈ {h.feeAprPct.toFixed(1)}% (last {formatWindow(h.feeAprWindowDays!)}, pool-wide
                        {h.feeAprEstimated ? ', preliminary — from recent swap volume, not yet the full snapshot history' : ''}
                        ), currently <span className={h.isStaked ? 'basis-pos' : ''}>{h.isStaked ? 'staked' : 'unstaked'}</span>
                      </div>
                    ) : (
                      <div className="geo-note">Fee APR: collecting data — check back in a day or two.</div>
                    )}
                    {h.gaugeAprPct != null ? (
                      <div className="geo-note">
                        Gauge APR ≈ {h.gaugeAprPct.toFixed(1)}% if staked ({h.stakedRatioPct != null ? h.stakedRatioPct.toFixed(0) : '?'}%
                        of this pool is)
                        {h.feeAprPct != null && (
                          <>
                            {' — '}
                            <span className={h.gaugeAprPct > h.feeAprPct ? 'basis-pos' : 'basis-neg'}>
                              {h.gaugeAprPct > h.feeAprPct ? 'staking currently earns more' : 'pure fees currently earn more'}
                            </span>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="geo-note">Gauge APR: unavailable right now — try again shortly.</div>
                    )}
                    {h.votingIncentiveFlag?.outpacing && (
                      <div className="geo-note">
                        <span className="basis-neg">Voting incentives ({usd(h.votingIncentiveFlag.bribesUsd)}) outpaced trading fees (
                        {usd(h.votingIncentiveFlag.feesUsd)}) last epoch</span>
                        {h.votingIncentiveFlag.hasUnpricedBribes && ' (some bribe tokens unpriced, floor only)'} — this
                        gauge&apos;s APR may be governance-subsidized right now, not earned from organic trading volume.
                      </div>
                    )}
                    {h.inRangeProbabilityPct != null ? (
                      <div className="geo-note">
                        ≈{h.inRangeProbabilityPct.toFixed(0)}% chance still in range in {h.inRangeHorizonDays}d
                      </div>
                    ) : (
                      <div className="geo-note">In-range odds: collecting price history — check back soon.</div>
                    )}
                    {(h.feesEarnedUsd > 0 || h.emissionsEarnedAero > 0) && (
                      <div className="geo-note">
                        {h.feesEarnedUsd > 0 && <>+{usd(h.feesEarnedUsd)} fees</>}
                        {h.feesEarnedUsd > 0 && h.emissionsEarnedAero > 0 && ' · '}
                        {h.emissionsEarnedAero > 0 && <>+{shares(h.emissionsEarnedAero)} AERO</>}
                      </div>
                    )}
                    {h.lockedUntil != null && <div className="geo-note">Locked until {lockDate(h.lockedUntil)}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
