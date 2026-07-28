import type { ReactNode } from 'react';
import { Space_Grotesk, Inter } from 'next/font/google';
import './globals.css';
import { WalletProvider } from '../components/WalletProvider';

const display = Space_Grotesk({ subsets: ['latin'], variable: '--ff-display', display: 'swap' });
const sans = Inter({ subsets: ['latin'], variable: '--ff-sans', display: 'swap' });

export const metadata = {
  title: 'BSV Launchpad',
  description: 'Issue and sell tokens on the BSV Blockchain.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
