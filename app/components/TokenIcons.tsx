'use client';

import { createContext, useContext } from 'react';

const Ctx = createContext<Record<string, string>>({});

// Icon URLs (by cash ticker) fetched once on the server in the root layout.
export function TokenIconsProvider({ icons, children }: { icons: Record<string, string>; children: React.ReactNode }) {
  return <Ctx.Provider value={icons}>{children}</Ctx.Provider>;
}

export const useTokenIcon = (cashTicker: string): string | undefined => useContext(Ctx)[cashTicker];
