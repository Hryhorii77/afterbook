'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import { useTheme } from './components/theme';
import { wagmiConfig } from '@/lib/wagmiConfig';

// Match this app's own palette (app/globals.css) rather than RainbowKit's
// default blue/purple — the wallet modal should look like part of Afterbook,
// in whichever theme is active.
const rainbowKitThemes = {
  dark: darkTheme({ accentColor: '#9cd6ff', accentColorForeground: '#111111', borderRadius: 'medium', fontStack: 'system' }),
  light: lightTheme({ accentColor: '#1f4fe0', accentColorForeground: '#ffffff', borderRadius: 'medium', fontStack: 'system' }),
};

export function Providers({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  // Created once per browser session (not per render) — a fresh QueryClient
  // on every render would drop RainbowKit/wagmi's own query cache and
  // refetch on each rerender.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowKitThemes[theme]}>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
