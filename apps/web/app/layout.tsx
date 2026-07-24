import type { ReactNode } from 'react';

export const metadata = {
  title: 'BSV Launchpad',
  description: 'A token launchpad native to the BSV Blockchain.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
