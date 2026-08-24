'use client';

import { useState, useEffect } from 'react';
import { SiteHeader } from '../../components/SiteHeader';
import { SiteFooter } from '../../components/SiteFooter';
import { Tabs } from '../../components/ui/Tabs';
import { useWallet } from '../../components/WalletProvider';
import { Button } from '../../components/ui';
import { PortfolioHoldings } from '../../components/PortfolioHoldings';
import { PortfolioHistory } from '../../components/PortfolioHistory';

export default function PortfolioPage() {
  const { connect, status } = useWallet();
  const [identityKey, setIdentityKey] = useState<string | null>(null);

  // Get identity key when wallet connects
  useEffect(() => {
    async function fetchIdentityKey() {
      if (status !== 'connected') return;
      try {
        const { getWalletClient } = await import('@launchpad/bsv/wallet');
        const wallet = await getWalletClient();
        const { publicKey } = await wallet.getPublicKey({ identityKey: true });
        setIdentityKey(publicKey);
      } catch (e) {
        console.error('Failed to get identity key:', e);
      }
    }
    fetchIdentityKey();
  }, [status]);

  async function handleConnect() {
    try {
      await connect();
    } catch (e) {
      console.error('Wallet connection failed:', e);
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto min-h-screen max-w-[1120px] px-4 py-10 sm:px-6">
        <div className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.18em] text-gold">Your holdings</span>
          <h1 className="mt-1 text-[1.75rem] font-semibold">Portfolio</h1>
          <p className="mt-2 text-sm text-muted">
            View your token holdings and purchase history. All transactions are SPV-verifiable on mainnet.
          </p>
          {identityKey && (
            <div className="mt-3 flex items-center gap-2 font-mono text-xs text-faint">
              <span>Identity:</span>
              <span className="rounded bg-elevated px-2 py-1">
                {identityKey.slice(0, 8)}...{identityKey.slice(-8)}
              </span>
            </div>
          )}
        </div>

        {status !== 'connected' ? (
          <div className="rounded-lg border border-line bg-surface p-8 text-center">
            <h2 className="mb-2 text-xl font-semibold">Connect your wallet</h2>
            <p className="mb-6 text-sm text-muted">
              Connect your BSV Desktop wallet to view your portfolio. Your keys never leave your wallet.
            </p>
            <Button variant="primary" onClick={handleConnect}>
              Connect Wallet
            </Button>
          </div>
        ) : !identityKey ? (
          <div className="rounded-lg border border-line bg-surface p-8 text-center">
            <p className="text-sm text-muted">Loading identity...</p>
          </div>
        ) : (
          <Tabs
            tabs={[
              {
                id: 'holdings',
                label: 'Holdings',
                content: <PortfolioHoldings identityKey={identityKey} />,
              },
              {
                id: 'history',
                label: 'History',
                content: <PortfolioHistory identityKey={identityKey} />,
              },
            ]}
          />
        )}
      </main>
      <SiteFooter />
    </>
  );
}
