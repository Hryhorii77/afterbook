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
  base as baseAccountWallet,
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

// A custom wallet list rather than RainbowKit's built-in default. Base Account (RainbowKit's `base`
// wallet: sign in with a passkey, no seed phrase) comes first (owner, 2026-11-03). It pulls in
// @base-org/account -> @coinbase/cdp-sdk, whose Solana path imports @x402/svm, which isn't
// installed; `serverExternalPackages` in next.config.js keeps the build from bundling into it, and
// that path is never called here (it was left out until 2026-11-03 for that build error).
// coinbaseWallet below is the classic Coinbase Wallet SDK connector. injectedWallet is the generic catch-all so any installed
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

// On a phone with no injected provider (a normal phone browser) the list is just Base Account and
// WalletConnect: Base Account signs in with a passkey in a Coinbase web window, and WalletConnect
// opens its own All Wallets window (MetaMask, Rabby, Trust...), which is what Connect opened directly
// on phones until 2026-11-03. RainbowKit's per-wallet entries (Rainbow, Trust...) are left out there.
const wallets = extensionWalletsUseless
  ? [{ groupName: 'Popular', wallets: [baseAccountWallet, ...(hasWalletConnectProjectId ? [walletConnectWallet] : [])] }]
  : [
      {
        groupName: 'Popular',
        wallets: [baseAccountWallet, injectedWallet, coinbaseWallet, rabbyWallet, ...(hasWalletConnectProjectId ? [rainbowWallet] : [])],
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
  // WalletConnect's own wallet window (the WalletConnect entry; on phones the second of two) lists
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
