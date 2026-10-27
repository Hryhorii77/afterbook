'use client';

import Link from 'next/link';
import { useEffect } from 'react';

// Shown when a page fails to render (a chain read or a data fetch threw). The error itself stays in the
// browser console and the server log; the page only gets Next's digest, never the message.
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main>
      <header className="top">
        <h1>Something went wrong</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        This page could not load just now, usually because a price or pool read timed out. Nothing in your wallet was
        touched. Try again in a moment.
        {error.digest && <> (Reference: {error.digest})</>}
      </p>
      <div className="basket-row">
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="btn btn-secondary">
          Go to the tape
        </Link>
      </div>
    </main>
  );
}
