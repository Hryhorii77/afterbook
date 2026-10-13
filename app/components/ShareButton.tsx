'use client';

import { useEffect, useRef, useState } from 'react';
import { cardPath, type CardSpec } from '@/lib/cardUrl';
import { useTheme } from './theme';

const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;
const ShareIcon = () => (
  <svg {...svgProps}>
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="m16 6-4-4-4 4" />
    <path d="M12 2v13" />
  </svg>
);
const ExternalIcon = () => (
  <svg {...svgProps}>
    <path d="M7 17 17 7" />
    <path d="M8 7h9v9" />
  </svg>
);
const CopyIcon = () => (
  <svg {...svgProps}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
const CheckIcon = () => (
  <svg {...svgProps}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const DownloadIcon = () => (
  <svg {...svgProps}>
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    <path d="m8 11 4 4 4-4" />
    <path d="M12 3v12" />
  </svg>
);

interface ShareButtonProps {
  /** Path of the page being shared, e.g. "/MSTRc" or "/today". */
  path: string;
  /** What the card shows. On /today pass the stock on screen: it rides in the shared link
   *  (`sym`), so the preview shows that stock even if another takes the lead a second later. */
  card: CardSpec;
  /** File name for "Download card". */
  fileName: string;
  /** The sentence that goes with the link: facts only, no advice. */
  text: string;
}

// Share what's on screen: post it on X, copy the link, download the card image, or (where the
// browser has one) open the system share sheet. The link is built from the page's own origin,
// so it is right on the live site, a preview deploy and localhost alike.
export function ShareButton({ path, card, fileName, text }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('https://afterbook.app');
  const [stamp, setStamp] = useState('');
  const [canNativeShare, setCanNativeShare] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const theme = useTheme();

  useEffect(() => {
    setOrigin(window.location.origin);
    setCanNativeShare(typeof navigator.share === 'function');
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // X and Telegram cache a link's preview card by its exact URL (X for about a week), and the card
  // shows live numbers. A bare /MSTRc would keep showing whatever it looked like the first time
  // anyone shared it, contradicting the sentence in the post. A fresh stamp per share (set when
  // the panel opens) makes every share a new URL, so the card is fetched at share time.
  // The link also carries the sharer's theme and, on /today, the stock shown, so the preview card
  // and "Download card" are the same image as the one on screen (lib/cardUrl.ts).
  const q = new URLSearchParams();
  if (stamp) q.set('s', stamp);
  if (card.page === 'today' && card.sym) q.set('sym', card.sym);
  if (theme === 'light') q.set('theme', 'light');
  const qs = q.toString();
  const url = `${origin}${path}${qs ? `?${qs}` : ''}`;
  const imageHref = cardPath(card, { theme, s: stamp || undefined });
  const xHref = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context, permissions); the other options still work.
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: 'Afterbook', text, url });
      setOpen(false);
    } catch {
      // Cancelled by the person, or not allowed: nothing to do.
    }
  };

  return (
    <div className="share-wrap" ref={wrapRef}>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          setStamp(Date.now().toString(36));
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="share-label">
          <ShareIcon />
          Share
        </span>
      </button>

      {open && (
        <div className="share-panel" role="dialog" aria-label="Share">
          {canNativeShare && (
            <button type="button" className="share-item" onClick={nativeShare}>
              <ShareIcon />
              Share via…
            </button>
          )}
          <a className="share-item" href={xHref} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
            <ExternalIcon />
            Post on X
          </a>
          <button type="button" className="share-item" onClick={copyLink}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <a className="share-item" href={imageHref} download={fileName} onClick={() => setOpen(false)}>
            <DownloadIcon />
            Download card
          </a>
        </div>
      )}
    </div>
  );
}
