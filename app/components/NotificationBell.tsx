'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useNotify } from './notify';

const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function NotificationBell() {
  const { liveOn, setLiveOn, recent, ready } = useNotify();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="bell-wrap" ref={wrapRef}>
      <button
        type="button"
        className="theme-toggle bell-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications, live alerts ${liveOn ? 'on' : 'off'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {/* Status light, not an unread count: lit while live alerts are on. */}
        {ready && liveOn && <span className="bell-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <h2>Notifications</h2>
            <button type="button" className="toast-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <p className="bell-sub">Choose what interrupts your browsing.</p>

          <div className="bell-row">
            <div>
              <div className="bell-row-title">Live market alerts</div>
              <div className="bell-row-body">Popups when a gap passes 100 bp, or the cash market opens or closes.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={liveOn}
              aria-label="Live market alerts"
              className={`switch${liveOn ? ' switch-on' : ''}`}
              onClick={() => setLiveOn(!liveOn)}
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="bell-row bell-row-fixed">
            <div>
              <div className="bell-row-title">Your transactions</div>
              <div className="bell-row-body">Confirmations and important notices still appear.</div>
            </div>
            <span className="bell-always">Always on</span>
          </div>

          {recent.length > 0 && (
            <div className="bell-recent">
              <div className="bell-recent-title">Recent</div>
              {recent.map((e) => (
                <div key={e.id} className="bell-recent-item">
                  <div>
                    {e.href ? (
                      <Link href={e.href} onClick={() => setOpen(false)}>
                        {e.title}
                      </Link>
                    ) : (
                      e.title
                    )}
                    {e.body && <div className="bell-row-body">{e.body}</div>}
                  </div>
                  <span className="bell-ago">{ago(e.at)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="bell-foot">Saved in this browser. Alerts only appear while Afterbook is open.</div>
        </div>
      )}
    </div>
  );
}
