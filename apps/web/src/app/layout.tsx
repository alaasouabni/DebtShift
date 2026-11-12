import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { SiteFooter, SiteHeader } from '../components/shell/index';
import { WalletProvider } from '../features/wallet/wallet-context';
import { THEME_BOOTSTRAP_SCRIPT } from '../lib/theme';

import './globals.css';

export const metadata: Metadata = {
  title: 'DebtShift | Safer cross-chain refinancing',
  description: 'Compare and execute bounded test-funds debt refinancing routes.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    /*
     * `suppressHydrationWarning` because the bootstrap script below sets
     * `data-theme` on this element before React hydrates. The server cannot
     * know the user's theme, so the attribute legitimately differs between
     * the server markup and the first client render.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Runs before first paint, so a user who chose dark never sees a white
          flash. Everything else about the theme lives in React.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {/*
          Figtree, the design system's typeface. Loaded by link rather than
          next/font so a build without network access still succeeds — the
          token's fallback stack carries the layout in that case.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,300..900;1,300..900&display=swap"
        />
      </head>
      <body>
        <WalletProvider>
          <div className="shell">
            <SiteHeader />
            <main style={{ flexGrow: 1 }}>{children}</main>
            <SiteFooter />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
