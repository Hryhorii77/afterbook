import type { CbStock } from '@/lib/stocks/tokens';

export function MarketsFooter({ activeStock }: { activeStock: CbStock }) {
  return (
    <footer className="site-footer">
      <div className="footer-columns">
        <div className="footer-brand">
          <div className="footer-brand-name">Afterbook</div>
          <p className="footer-tagline">How far tokenized stocks trade from the cash market. Trade them from your own wallet.</p>
          <div className="footer-links">
            <a href="https://x.com/hryhorii77" target="_blank" rel="noopener noreferrer">X</a>
            <a href="https://github.com/Hryhorii77/afterbook" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="https://github.com/Hryhorii77/afterbook#readme" target="_blank" rel="noopener noreferrer">README</a>
          </div>
        </div>
        <div className="footer-onchain">
          <div className="footer-label">Onchain</div>
          <a href={`https://basescan.org/address/${activeStock.tokenAddress}`} target="_blank" rel="noopener noreferrer">
            Token&nbsp;<span className="ext-arrow">↗</span>
          </a>
          <a href={`https://basescan.org/address/${activeStock.pool.address}`} target="_blank" rel="noopener noreferrer">
            Pool&nbsp;<span className="ext-arrow">↗</span>
          </a>
          <a href="https://www.base.org/stocks" target="_blank" rel="noopener noreferrer">
            Coinbase tokenized stocks&nbsp;<span className="ext-arrow">↗</span>
          </a>
        </div>
      </div>
      <div className="footer-legal">
        <p>Not investment advice. Not available in the US.</p>
        <p>
          Company logos are the token icons published by Coinbase and belong to their owners. Afterbook is not
          affiliated with them.
        </p>
        <p>
          Baskets: trading and accounts run on{' '}
          <a href="https://glider.fi" target="_blank" rel="noopener noreferrer" className="emph-link">
            Glider&nbsp;<span className="ext-arrow">↗</span>
          </a>
          ; see the{' '}
          <a href="/baskets/risks" className="emph-link">
            risks and terms
          </a>
          .
        </p>
        <p>
          Independent and non-custodial. Not affiliated with Coinbase, Base, NVIDIA, or the issuer. B20 backing is
          the issuer&apos;s claim — this app does not verify reserves onchain. Never asks for a seed phrase.
        </p>
      </div>
      <p className="footer-meta">MIT licensed · Built on Base</p>
    </footer>
  );
}
