'use client';

import { useEffect, useRef } from 'react';
import { detectEvents, type AlertSnapshot, type TapeLite } from '@/lib/liveAlerts';
import { useNotify } from './notify';

const POLL_MS = 60_000;

// Watches the public tape while the tab is open and turns edge-triggered
// changes into toasts. Renders nothing. The first read only sets the baseline,
// so opening the site never fires an alert for something already true.
export function LiveAlerts() {
  const { liveOn, notify } = useNotify();
  const snapshot = useRef<AlertSnapshot | null>(null);

  useEffect(() => {
    if (!liveOn) {
      // Forget the baseline: after switching back on, whatever is true then is
      // the new starting point rather than a burst of stale alerts.
      snapshot.current = null;
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/tape', { cache: 'no-store' });
        if (!res.ok) return;
        const tape = (await res.json()) as TapeLite;
        if (cancelled || !tape?.rows || !tape?.session) return;
        const { events, next } = detectEvents(snapshot.current, tape);
        snapshot.current = next;
        for (const e of events.slice(0, 3)) notify({ kind: 'activity', tone: 'info', title: e.title, body: e.body, href: e.href });
      } catch {
        // A failed poll just skips this tick.
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveOn, notify]);

  return null;
}
