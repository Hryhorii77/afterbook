'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { wagmiConfig } from '@/lib/wagmiConfig';

// Matches this app's own palette (app/globals.css :root) rather than
// RainbowKit's default blue/purple theme — the wallet modal should look
// like part of Afterbook, not a bolted-on third-party widget.
const rainbowKitTheme = darkTheme({
  accentColor: '#5b8cff',
  accentColorForeground: '#111111',
  borderRadius: 'medium',
  fontStack: 'system',
});

export function Providers({ children }: { children: React.ReactNode }) {
  // Created once per browser session (not per render) — a fresh QueryClient
  // on every render would drop RainbowKit/wagmi's own query cache and
  // refetch on each rerender.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowKitTheme}>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
