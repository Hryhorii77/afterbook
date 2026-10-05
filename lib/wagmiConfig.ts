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

// Phones have no browser extensions, so "Browser Wallet" and Rabby (extension only) can never
// connect there. (Phones without an injected provider skip this list altogether and open
// WalletConnect's own wallet window, see WalletConnectButton.) The list is built when this
// module loads, in the browser, where the user agent is known; on the server it is just the
// desktop list. MetaMask is deliberately not here: RainbowKit's MetaMask entry uses MetaMask's
// own SDK relay and did nothing on a phone, while MetaMask works through WalletConnect's list;
// on desktop it also clashes with Rabby's compatibility flag, as described above.
const onPhone = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
// With an injected provider (an extension, or a wallet app's in-app browser) the injected
// entries are the right ones even on a phone.
const hasInjectedProvider = typeof window !== 'undefined' && Boolean((window as { ethereum?: unknown }).ethereum);
const extensionWalletsUseless = onPhone && !hasInjectedProvider;

const wallets = [
  {
    groupName: 'Popular',
    wallets: [
      ...(extensionWalletsUseless ? [] : [injectedWallet]),
      coinbaseWallet,
      ...(extensionWalletsUseless ? [] : [rabbyWallet]),
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
  // WalletConnect's own wallet window (opened directly on phones, see WalletConnectButton) lists
  // these first, in this order, before the search over hundreds of others. Ids come from
  // WalletConnect's registry (api.web3modal.org/getWallets?search=<name>).
  walletConnectParameters: {
    qrModalOptions: {
      explorerRecommendedWalletIds: [
        'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // MetaMask,
        '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1', // Rabby,
        'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa', // Base (formerly Coinbase Wallet),
        '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0', // Trust Wallet,
        '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369', // Rainbow,
        '971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709', // OKX Wallet,
        'ecc4036f814562b41a5268adc86270fba1365471402006302e70169465b7ac18', // Zerion,
      ],
    },
  },
});
