'use client';

import Link from 'next/link';
import { useNotify } from './notify';

export function Toaster() {
  const { toasts, dismiss } = useNotify();
  return (
    // aria-live so screen readers announce a toast without stealing focus.
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span className="toast-dot" aria-hidden="true" />
          <div className="toast-text">
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
            {t.href && (
              <Link href={t.href} className="toast-link" onClick={() => dismiss(t.id)}>
                View →
              </Link>
            )}
          </div>
          <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
