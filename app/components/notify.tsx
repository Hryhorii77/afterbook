'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// App-wide notifications, in two classes (mirrors the bell's popover):
//  - 'activity': live market alerts. The visitor can switch these off.
//  - 'tx': the visitor's own transactions. Always shown; the switch can't touch them.
// The switch is stored in this browser only (no accounts).

export type ToastTone = 'info' | 'success' | 'error';
export interface ToastInput {
  kind: 'activity' | 'tx';
  tone?: ToastTone;
  title: string;
  body?: string;
  href?: string;
}
export interface Toast extends ToastInput {
  id: number;
  tone: ToastTone;
}
export interface RecentEvent {
  id: number;
  at: number;
  title: string;
  body?: string;
  href?: string;
}

const PREFS_KEY = 'afterbook-notify';
const MAX_VISIBLE = 3;
const TOAST_MS = 7000;
const MAX_RECENT = 6;

interface NotifyValue {
  liveOn: boolean;
  setLiveOn: (on: boolean) => void;
  notify: (t: ToastInput) => void;
  toasts: Toast[];
  dismiss: (id: number) => void;
  recent: RecentEvent[];
  /** True once the saved choice has been read, so the UI never flashes the default. */
  ready: boolean;
}

const Ctx = createContext<NotifyValue | null>(null);

export function useNotify(): NotifyValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNotify must be used inside <NotifyProvider>');
  return v;
}

export function NotifyProvider({ children }: { children: React.ReactNode }) {
  // On by default (server render and first client render agree); the saved
  // choice is applied right after mount.
  const [liveOn, setLiveOnState] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  const [ready, setReady] = useState(false);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
      if (saved && typeof saved.live === 'boolean') setLiveOnState(saved.live);
    } catch {
      // Blocked or corrupt storage: keep the default.
    }
    setReady(true);
  }, []);

  const setLiveOn = useCallback((on: boolean) => {
    setLiveOnState(on);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ live: on }));
    } catch {
      // Still applies for this page view.
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const liveRef = useRef(liveOn);
  liveRef.current = liveOn;

  const notify = useCallback(
    (input: ToastInput) => {
      // The switch only governs live market alerts; transactions always show.
      if (input.kind === 'activity' && !liveRef.current) return;
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-(MAX_VISIBLE - 1)), { ...input, id, tone: input.tone ?? 'info' }]);
      timers.current.set(id, setTimeout(() => dismiss(id), TOAST_MS));
      if (input.kind === 'activity') {
        setRecent((list) => [{ id, at: Date.now(), title: input.title, body: input.body, href: input.href }, ...list].slice(0, MAX_RECENT));
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  const value = useMemo(
    () => ({ liveOn, setLiveOn, notify, toasts, dismiss, recent, ready }),
    [liveOn, setLiveOn, notify, toasts, dismiss, recent, ready],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
