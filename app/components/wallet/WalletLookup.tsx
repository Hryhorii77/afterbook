'use client';

// "Look up a wallet" (2026-11-26, /portfolio and /borrow): type a 0x address or a Basename and see that wallet's public
// positions without connecting. Read-only: it only resolves a name to an address; nothing here can sign or send.
import { useState } from 'react';
import { parseWalletInput } from '@/lib/wallet/walletInput';

export interface LookedUp {
  address: `0x${string}`;
  /** The Basename it was looked up by, if any. */
  name: string | null;
}

export function WalletLookup({ onFound, label = 'Look up a wallet', initial = '' }: { onFound: (w: LookedUp) => void; label?: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseWalletInput(value);
    if (!parsed) return setError('Enter a 0x address or a Basename, like jesse.base.eth.');
    if (parsed.kind === 'address') {
      setError(null);
      return onFound({ address: parsed.address, name: null });
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/basename?name=${encodeURIComponent(parsed.name)}`);
      const json = (await res.json()) as { address?: `0x${string}` | null; error?: string };
      if (!res.ok) setError(res.status === 429 ? 'Too many lookups. Try again in a minute.' : res.status === 400 ? 'That isn’t a Basename.' : 'Couldn’t look that up. Try again.');
      else if (!json.address) setError(`${parsed.name} doesn’t point to a wallet.`);
      else onFound({ address: json.address, name: parsed.name });
    } catch {
      setError('Couldn’t look that up. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="wallet-lookup" onSubmit={submit}>
      <label className="wallet-lookup-label" htmlFor="wallet-lookup-input">
        {label}
      </label>
      <div className="basket-row wallet-lookup-row">
        <input
          id="wallet-lookup-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="0x… or name.base.eth"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn btn-secondary" disabled={busy || !value.trim()}>
          {busy ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      {error && <p className="geo-note" role="alert">{error}</p>}
    </form>
  );
}
