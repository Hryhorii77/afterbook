import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  injectedWallet,
  rabbyWallet,
  coinbaseWallet,
  rainbowWallet,
  trustWallet,
  okxWallet,
  zerionWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { fallback, http } from 'viem';
import { base } from 'viem/chains';

// Same official-endpoint-first, public-fallback-second pattern as the
// server-side client in lib/quote.ts — see that file's comment for why
// (mainnet.base.org is Base's own documented endpoint; publicnode is a
// fallback only). This client only backs wagmi's own connector plumbing —
// My Lots still reads balances/positions through /api/lots server-side,
// not through this transport directly.
const transport = fallback([http('https://mainnet.base.org'), http('https://base-rpc.publicnode.com')]);

// A custom wallet list rather than RainbowKit's built-in default: its
// default list includes a "Base" entry backed by wagmi/connectors'
// baseAccount connector, which pulls in @base-org/account -> @coinbase/
// cdp-sdk -> a dynamic import of @x402/svm/exact/client (Solana) that
// isn't installed here (this app is EVM/Base-only, and already has its own
// unrelated @x402/* deps for the x402 payment routes) — Turbopack's SSR
// bundling of that chain fails the build outright. Confirmed via each
// connector's own source that only that one entry touches cdp-sdk;
// coinbaseWallet below is the classic Coinbase Wallet SDK connector and is
// unaffected. injectedWallet is the generic catch-all so any installed
// extension RainbowKit doesn't have a named definition for (beyond the
// EIP-6963-autodetected ones already in this list) still shows up under
// "Installed" instead of being invisible.
//
// rainbowWallet/trustWallet/okxWallet/zerionWallet/walletConnectWallet are
// only added when a real WalletConnect/Reown project id is configured. Each
// of those, absent a matching browser extension, connects via WalletConnect
// — and wagmi instantiates that connector's WalletConnect Core (which opens
// a relay socket) at config-build time, not lazily on click. With no real
// project id, that socket churns against the relay continuously (confirmed:
// caused the whole tab to hang and never reach document_idle) — so those
// entries are simply left out rather than shipped broken. coinbase/rabby/
// injected all have real desktop-extension connectors and need no
// WalletConnect involvement at all.
//
// No metaMaskWallet entry, deliberately: RainbowKit's per-wallet detection
// is purely flag-based (window.ethereum.isMetaMask), not EIP-6963/rdns —
// and several alternative wallets (Rabby included) set that same
// compatibility flag so MetaMask-aware dapps still recognize them. With
// both installed, whichever wallet currently holds window.ethereum answers
// to "MetaMask" regardless of which one is real, and confirmed in practice
// (console: "Error: MetaMask extension not found" thrown from inside the
// click) — clicking "MetaMask" can silently attempt to connect through a
// different wallet's shim, which then fails outright rather than opening
// the real extension. rabbyWallet below checks the isRabby flag
// specifically, which only Rabby sets, so it doesn't have this ambiguity.
// injectedWallet (generic "Browser Wallet") remains as the correct fallback
// for a real MetaMask-only setup with no other flag-setting wallet present.
const hasWalletConnectProjectId = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

const wallets = [
  {
    groupName: 'Popular',
    wallets: [
      injectedWallet,
      coinbaseWallet,
      rabbyWallet,
      ...(hasWalletConnectProjectId ? [rainbowWallet] : []),
    ],
  },
  ...(hasWalletConnectProjectId
    ? [{ groupName: 'More', wallets: [trustWallet, okxWallet, zerionWallet, walletConnectWallet] }]
    : []),
];

export const wagmiConfig = getDefaultConfig({
  appName: 'Afterbook',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '00000000000000000000000000000000',
  wallets,
  chains: [base],
  transports: { [base.id]: transport },
  ssr: true,
});
