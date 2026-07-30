'use client';

import { useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button } from './ui';
import { useWallet } from './WalletProvider';
import { createCurvePool, markCurvePoolDeployed } from '../lib/curve-actions';

/**
 * Owner-only: deploy the bonding-curve pool covenant on mainnet (ADR-026). Creates
 * the pool row, deploys the genesis covenant seeded with a base reserve via the
 * owner's wallet, then records the outpoint (which opens the sale for buying).
 * Server actions enforce project ownership; non-owners are rejected.
 */
export function CurvePoolDeploy({ s }: { s: SaleCardVM }) {
  const { connect } = useWallet();
  const [seed, setSeed] = useState(546);
  const [status, setStatus] = useState<'idle' | 'deploying' | 'done'>('idle');
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function deploy() {
    setStatus('deploying');
    setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { deployCurvePool } = await import('@launchpad/curve');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });

      // Idempotent-ish: create the row (ignore "already exists").
      const created = await createCurvePool({ saleId: s.saleId, identityPubkey: identity, seedReserveSats: seed });
      if (!created.ok && !/already exists/.test(created.error ?? '')) throw new Error(created.error);

      const dep = await deployCurvePool({ wallet: wallet as never, chain: 'main', seedReserveSats: seed });

      const rec = await markCurvePoolDeployed({
        saleId: s.saleId,
        identityPubkey: identity,
        txid: dep.pool.txid,
        vout: dep.pool.vout,
        scriptHex: dep.pool.scriptHex,
        reserveSats: dep.pool.reserveSats,
      });
      if (!rec.ok) throw new Error(rec.error);

      setTxid(dep.pool.txid);
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
    }
  }

  return (
    <div className="card flex flex-col gap-4 p-6">
      <h2 className="text-lg font-semibold">Deploy the curve pool</h2>
      <p className="text-sm text-muted">
        Project owner only. Deploys the bonding-curve reserve covenant on mainnet. Once live, anyone can buy along the
        curve. Uses real sats for the seed reserve — keep it small.
      </p>
      <label className="flex flex-col gap-1 text-xs text-faint">
        Seed reserve (sats)
        <input
          type="number"
          min={546}
          value={seed}
          onChange={(e) => setSeed(Math.floor(Number(e.target.value)))}
          className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg"
        />
      </label>
      <Button onClick={deploy} disabled={status === 'deploying'} block>
        {status === 'deploying' ? 'Deploying…' : 'Deploy pool'}
      </Button>
      {txid && (
        <a href={`https://whatsonchain.com/tx/${txid}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-teal underline underline-offset-2">
          {txid}
        </a>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
