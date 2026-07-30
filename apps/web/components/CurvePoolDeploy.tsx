'use client';

import { useState } from 'react';
import { Button } from './ui';
import { useWallet } from './WalletProvider';
import { createCurvePool, markCurvePoolDeployed } from '../lib/curve-actions';
import { createLedgerPool } from '../lib/ledger-actions';

/**
 * Owner-only: deploy the bonding-curve pool covenant on mainnet. Two variants:
 * LINEAR (buy-only, ADR-026) or LEDGER (buy + sell, trustless in-covenant balances,
 * ADR-027). Server actions enforce project ownership; non-owners are rejected.
 */
export function CurvePoolDeploy({ saleId }: { saleId: string }) {
  const { connect } = useWallet();
  const [variant, setVariant] = useState<'linear' | 'ledger'>('ledger');
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
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });

      let scriptHex: string;
      if (variant === 'ledger') {
        const created = await createLedgerPool({ saleId, identityPubkey: identity, seedReserveSats: seed });
        if (!created.ok || !created.scriptHex) throw new Error(created.error ?? 'create failed');
        scriptHex = created.scriptHex;
        const res = (await wallet.createAction({
          description: 'deploy ledger curve pool',
          outputs: [{ lockingScript: scriptHex, satoshis: seed, outputDescription: 'ledger curve pool covenant' }],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
        } as never)) as { txid: string };
        const dtxid: string = res.txid;
        const rec = await markCurvePoolDeployed({ saleId, identityPubkey: identity, txid: dtxid, vout: 0, scriptHex, reserveSats: seed });
        if (!rec.ok) throw new Error(rec.error);
        setTxid(dtxid);
      } else {
        const { deployCurvePool } = await import('@launchpad/curve');
        const created = await createCurvePool({ saleId, identityPubkey: identity, seedReserveSats: seed });
        if (!created.ok && !/already exists/.test(created.error ?? '')) throw new Error(created.error);
        const dep = await deployCurvePool({ wallet: wallet as never, chain: 'main', seedReserveSats: seed });
        const rec = await markCurvePoolDeployed({ saleId, identityPubkey: identity, txid: dep.pool.txid, vout: dep.pool.vout, scriptHex: dep.pool.scriptHex, reserveSats: dep.pool.reserveSats });
        if (!rec.ok) throw new Error(rec.error);
        setTxid(dep.pool.txid);
      }
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
        Project owner only. Deploys the bonding-curve reserve covenant on mainnet. Uses real sats for the seed
        reserve — keep it small.
      </p>
      <div className="flex flex-wrap gap-2">
        {(['ledger', 'linear'] as const).map((v) => (
          <button key={v} type="button" onClick={() => setVariant(v)} className="chip" data-active={variant === v}>
            {v === 'ledger' ? 'Buy + sell (trustless ledger)' : 'Buy-only (linear)'}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-xs text-faint">
        Seed reserve (sats)
        <input type="number" min={546} value={seed} onChange={(e) => setSeed(Math.floor(Number(e.target.value)))}
          className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg" />
      </label>
      <Button onClick={deploy} disabled={status === 'deploying'} block>
        {status === 'deploying' ? 'Deploying…' : 'Deploy pool'}
      </Button>
      {txid && <a href={`https://whatsonchain.com/tx/${txid}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-teal underline underline-offset-2">{txid}</a>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
