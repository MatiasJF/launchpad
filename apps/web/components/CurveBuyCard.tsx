'use client';

import { useEffect, useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { ShieldCheck } from './ui/icons';
import { useWallet } from './WalletProvider';
import { broadcastRawTx } from '../lib/settle-actions';
import { getCurvePoolState, recordCurveBuy } from '../lib/curve-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

/** Exact linear-curve cost to buy `delta` tokens (mirrors the covenant). */
function costFor(k: number, sold: number, delta: number): number {
  return (k * delta * (2 * sold + delta + 1)) / 2;
}

/**
 * Bonding-curve buy card (ADR-026). Price rises along the curve as tokens sell.
 * Non-custodial: the buyer funds + signs their own payment; the pool covenant
 * enforces the price on-chain and re-locks itself with the new state.
 */
export function CurveBuyCard({ s }: { s: SaleCardVM }) {
  const { connect } = useWallet();
  const [pool, setPool] = useState<{ sold: number; supply: number; k: number; reserveSats: number } | null>(null);
  const [amount, setAmount] = useState(1);
  const [status, setStatus] = useState<'idle' | 'buying' | 'done'>('idle');
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await getCurvePoolState(s.saleId);
    if (r.ok) setPool({ sold: r.pool.sold, supply: r.pool.supply, k: r.pool.k, reserveSats: r.pool.reserveSats });
  }
  useEffect(() => {
    void refresh();
  }, [s.saleId]);

  const remaining = pool ? pool.supply - pool.sold : 0;
  const delta = Math.max(0, Math.min(amount, remaining));
  const cost = pool && delta > 0 ? costFor(pool.k, pool.sold, delta) : 0;
  const open = s.saleState === 'open' && pool != null && remaining > 0;

  async function buy() {
    setStatus('buying');
    setError(null);
    try {
      if (!pool) throw new Error('pool not loaded');
      if (delta <= 0) throw new Error('enter a token amount');
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { buildCurveBuyTx } = await import('@launchpad/curve');
      const { PublicKey } = await import('@bsv/sdk');
      const wallet = await getWalletClient();

      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      const { publicKey: ownerPub } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self' });
      const receiveAddress = PublicKey.fromString(ownerPub).toAddress().toString();

      // Build against the LATEST pool outpoint (re-fetch to reduce races).
      const fresh = await getCurvePoolState(s.saleId);
      if (!fresh.ok) throw new Error(fresh.error);

      const res = await buildCurveBuyTx({
        wallet: wallet as never,
        chain: 'main',
        pool: fresh.pool,
        delta,
        buyerReceiveAddress: receiveAddress,
      });
      if (!res.ok) throw new Error(res.reason);

      const bc = await broadcastRawTx(res.rawTx, res.txid);
      if (!bc.ok) throw new Error(`buy broadcast rejected: ${bc.error}`);

      const rec = await recordCurveBuy({
        saleId: s.saleId,
        buyerIdentity: identity,
        receiveAddress,
        spentPoolTxid: fresh.pool.txid,
        spentPoolVout: fresh.pool.vout,
        buyTxid: bc.txid || res.txid,
        newPool: res.newPool,
        delta,
        cost: res.cost,
      });
      if (!rec.ok) throw new Error(rec.error);

      setTxid(bc.txid || res.txid);
      setStatus('done');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
    }
  }

  return (
    <div className="card flex flex-col gap-5 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Buy {s.ticker}</h2>
        <StatusPill status={s.status} />
      </div>

      <div className="flex items-center gap-2 text-sm text-teal">
        <ShieldCheck className="h-4 w-4" /> Bonding curve · price rises as tokens sell
      </div>

      {pool && (
        <div className="grid grid-cols-2 gap-3 font-mono text-xs">
          <div className="rounded-md border border-line bg-elevated/40 px-3 py-2">
            <div className="text-faint">sold</div>
            <div className="text-fg">{pool.sold.toLocaleString('en-US')} / {pool.supply.toLocaleString('en-US')}</div>
          </div>
          <div className="rounded-md border border-line bg-elevated/40 px-3 py-2">
            <div className="text-faint">reserve</div>
            <div className="text-fg">{pool.reserveSats.toLocaleString('en-US')} sats</div>
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1 text-xs text-faint">
        Tokens to buy
        <input
          type="number"
          min={1}
          max={remaining || undefined}
          value={amount}
          onChange={(e) => setAmount(Math.floor(Number(e.target.value)))}
          className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg"
        />
      </label>

      <div className="flex items-center justify-between font-mono text-sm">
        <span className="text-faint">cost</span>
        <span className="text-fg">{cost.toLocaleString('en-US')} sats</span>
      </div>

      <Button onClick={buy} disabled={!open || status === 'buying' || delta <= 0} block>
        {status === 'buying' ? 'Buying…' : !open ? (remaining <= 0 ? 'Sold out' : 'Not open') : `Buy ${delta} ${s.ticker}`}
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
