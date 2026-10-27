import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Page not found · Afterbook' };

// Unknown paths and unknown stock symbols. A plain ticker (/AAPL) never lands here: the symbol page
// redirects it to the token (/AAPLc).
export default function NotFound() {
  return (
    <main>
      <header className="top">
        <h1>Page not found</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        There is no page at this address. If you typed a stock, use its ticker, like /NVDA or /NVDAc. Every tokenized
        stock Coinbase issues on Base is listed on the Stocks page.
      </p>
      <div className="basket-row">
        <Link href="/" className="btn">
          Go to the tape
        </Link>
        <Link href="/stocks" className="btn btn-secondary">
          All stocks
        </Link>
      </div>
    </main>
  );
}
