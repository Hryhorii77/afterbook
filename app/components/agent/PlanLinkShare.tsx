'use client';

// Share a plan link (/plan/<id>, 2026-11-25): copy the page's own address, or the phone's share sheet where it has
// one. The link carries only what Afterbook's code decided (lib/agent/planLink.ts), never a wallet or an amount
// to sign, and whoever opens it gets the checks run again and signs in their own wallet. Nothing here is logged.
import { useEffect, useState } from 'react';

export function PlanLinkShare({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'), []);

  const url = () => window.location.href.split('#')[0];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (an old browser or a permission): the address bar has the same link.
      setCopied(false);
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title, text: 'A checked plan on Afterbook. Open it to see it checked again on live prices; you sign any buy yourself.', url: url() });
    } catch {
      // Dismissed: nothing to do.
    }
  };

  return (
    <div className="basket-row plan-link-share">
      <button type="button" className="btn btn-secondary" onClick={copy}>
        {copied ? 'Link copied' : 'Copy link'}
      </button>
      {canShare && (
        <button type="button" className="btn btn-secondary" onClick={share}>
          Share
        </button>
      )}
    </div>
  );
}
