'use client';

import { useState } from 'react';
import { Button } from './ui';
import { ShieldCheck } from './ui/icons';
import { useWallet } from './WalletProvider';
import { broadcastRawTx } from '../lib/settle-actions';
import type { DeployResult } from '@launchpad/curve';

/**
 * Phase-0 live proof of the bonding-curve OP_PUSH_TX covenant (ADR-026).
 * Deploys a trivial "Counter" covenant on mainnet, then broadcasts a
 * self-replicating spend that increments it — the same shape the AMM buy/sell
 * flow will take, minus the curve math. Non-custodial: the covenant carries no
 * signature; the wallet only funds the deploy and pays the increment's fee.
 */
export function CovenantSpike() {
  const { connect } = useWallet();
  const [covenantSats, setCovenantSats] = useState(1000);
  const [feeSats, setFeeSats] = useState(600);
  const [deploy, setDeploy] = useState<DeployResult | null>(null);
  const [incrTxid, setIncrTxid] = useState<string | null>(null);
  const [busy, setBusy] = useState<'idle' | 'deploying' | 'incrementing'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const woc = (txid: string) => `https://whatsonchain.com/tx/${txid}`;

  async function runDeploy() {
    setBusy('deploying');
    setError(null);
    setNote(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { deployCovenant } = await import('@launchpad/curve');
      const wallet = await getWalletClient();
      const res = await deployCovenant({ wallet: wallet as never, chain: 'main', covenantSats, feeSats });
      setDeploy(res);
      setNote('Covenant deployed at count = 0. Wait a few seconds for it to propagate, then increment.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }

  async function runIncrement() {
    if (!deploy) return;
    setBusy('incrementing');
    setError(null);
    setNote(null);
    try {
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { buildIncrementTx } = await import('@launchpad/curve');
      const wallet = await getWalletClient();
      const built = await buildIncrementTx({ wallet: wallet as never, covenant: deploy.covenant, fee: deploy.fee });
      if (!built.ok || !built.rawTx || !built.txid) throw new Error(built.reason ?? 'increment build failed');
      if (built.verifiedLocally === false) {
        throw new Error('local interpreter check failed (bsv-js vs @bsv/sdk preimage mismatch) — not broadcasting');
      }
      const bc = await broadcastRawTx(built.rawTx, built.txid);
      if (!bc.ok) throw new Error(`increment broadcast rejected: ${bc.error}`);
      setIncrTxid(bc.txid || built.txid);
      setNote('Self-replicating spend broadcast — the covenant is now count = 1. Phase 0 proven on mainnet. ✅');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }

  return (
    <div className="card flex flex-col gap-5 p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-teal" />
        <h2 className="text-lg font-semibold">Bonding-curve covenant · Phase 0 spike</h2>
      </div>
      <p className="max-w-[60ch] text-sm text-muted">
        Deploy a stateful OP_PUSH_TX covenant (a counter that may only increment by 1) on mainnet, then
        broadcast a self-replicating spend. This proves the AMM covenant mechanism end-to-end on-chain. Uses
        real sats — keep the amounts tiny.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-xs text-faint">
          Covenant sats
          <input
            type="number"
            value={covenantSats}
            min={546}
            onChange={(e) => setCovenantSats(Number(e.target.value))}
            className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-faint">
          Fee sats (all spent as miner fee)
          <input
            type="number"
            value={feeSats}
            min={300}
            onChange={(e) => setFeeSats(Number(e.target.value))}
            className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={runDeploy} disabled={busy !== 'idle'}>
          {busy === 'deploying' ? 'Deploying…' : '1 · Deploy covenant (count = 0)'}
        </Button>
        <Button onClick={runIncrement} disabled={busy !== 'idle' || !deploy || !!incrTxid} variant="secondary">
          {busy === 'incrementing' ? 'Broadcasting…' : '2 · Broadcast increment (→ 1)'}
        </Button>
      </div>

      {deploy && (
        <div className="rounded-md border border-line bg-elevated/30 p-3 font-mono text-xs">
          <div className="text-faint">deploy tx</div>
          <a href={woc(deploy.txid)} target="_blank" rel="noreferrer" className="break-all text-teal underline underline-offset-2">
            {deploy.txid}
          </a>
          <div className="mt-2 text-faint">covenant utxo</div>
          <div className="break-all text-muted">{deploy.covenant.txid}:{deploy.covenant.vout} · {deploy.covenant.satoshis} sats</div>
        </div>
      )}

      {incrTxid && (
        <div className="rounded-md border border-teal/40 bg-teal/5 p-3 font-mono text-xs">
          <div className="text-faint">increment tx (count 0 → 1)</div>
          <a href={woc(incrTxid)} target="_blank" rel="noreferrer" className="break-all text-teal underline underline-offset-2">
            {incrTxid}
          </a>
        </div>
      )}

      {note && <p className="text-sm text-teal">{note}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
