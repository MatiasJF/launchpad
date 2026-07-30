'use client';

import { useEffect, useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { ShieldCheck } from './ui/icons';
import { useWallet } from './WalletProvider';
import { broadcastRawTx } from '../lib/settle-actions';
import { getLedgerPool, prepareLedgerBuy, recordLedgerBuy, prepareLedgerSell, finalizeLedgerSell, recordLedgerSell } from '../lib/ledger-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

function cost(k: number, sold: number, delta: number): number {
  return (k * delta * (2 * sold + delta + 1)) / 2;
}

/**
 * Trustless bonding-curve trade card (ADR-027). Buy credits and sell debits an
 * in-covenant ledger keyed to the holder's key — no receipt token, reserve is
 * drain-proof. Non-custodial: the wallet funds buys + signs sells.
 */
export function LedgerTradeCard({ s }: { s: SaleCardVM }) {
  const { connect } = useWallet();
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [pool, setPool] = useState<{ sold: number; supply: number; k: number; reserveSats: number } | null>(null);
  const [myBalance, setMyBalance] = useState<number>(0);
  const [amount, setAmount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function myPkh(): Promise<string> {
    const { getWalletClient } = await import('@launchpad/bsv/wallet');
    const { PublicKey } = await import('@bsv/sdk');
    const wallet = await getWalletClient();
    const { publicKey } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self' });
    return Buffer.from(PublicKey.fromString(publicKey).toHash() as number[]).toString('hex');
  }

  async function refresh() {
    const r = await getLedgerPool(s.saleId);
    if (r.ok) {
      setPool({ sold: r.sold, supply: Number(r.supply), k: Number(r.k), reserveSats: r.reserveSats });
      try {
        const pkh = await myPkh();
        const held = r.balances.find((b) => b.ownerPkh.toLowerCase() === pkh.toLowerCase());
        setMyBalance(held ? Number(held.amount) : 0);
      } catch { /* wallet not connected yet */ }
    }
  }
  useEffect(() => { void refresh(); }, [s.saleId]);

  const remaining = pool ? pool.supply - pool.sold : 0;
  const open = s.saleState === 'open' && pool != null;
  const delta = Math.max(0, Math.min(amount, tab === 'buy' ? remaining : myBalance));
  const quote = pool && delta > 0
    ? tab === 'buy' ? cost(pool.k, pool.sold, delta) : cost(pool.k, pool.sold - delta, delta)
    : 0;

  async function broadcastWithParent(paymentRawTx: string | undefined, paymentTxid: string | undefined, rawTx: string, id: string) {
    // Push the payment (TX1) first, then the spend. WoC load-balances broadcast
    // nodes, so re-push the parent on each retry to seed whichever node gets the
    // spend, over a ~24s window while it propagates.
    if (paymentRawTx) await broadcastRawTx(paymentRawTx, paymentTxid);
    let bc = await broadcastRawTx(rawTx, id);
    for (let i = 0; i < 8 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (paymentRawTx) await broadcastRawTx(paymentRawTx, paymentTxid);
      bc = await broadcastRawTx(rawTx, id);
    }
    return bc;
  }

  async function doBuy() {
    setBusy(true); setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { buildLedgerBuyTx } = await import('@launchpad/curve');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      const pkh = await myPkh();

      const prep = await prepareLedgerBuy({ saleId: s.saleId, buyerPkh: pkh, delta });
      if (!prep.ok) throw new Error(prep.error);
      const built = await buildLedgerBuyTx({
        wallet: wallet as never, chain: 'main',
        pool: { txid: prep.poolTxid, vout: prep.poolVout, scriptHex: prep.sourceLockHex, reserveBefore: prep.reserveBefore },
        unlockingHex: prep.unlockingHex, nextLockingHex: prep.nextLockingHex,
        newReserve: prep.newReserve, cost: prep.cost, sold: prep.sold, delta,
      });
      if (!built.ok || !built.rawTx || !built.txid || !built.newPool) throw new Error(built.reason ?? 'buy build failed');

      const bc = await broadcastWithParent(built.paymentRawTx, built.paymentTxid, built.rawTx, built.txid);
      if (!bc.ok) throw new Error(`buy broadcast rejected: ${bc.error}`);

      const rec = await recordLedgerBuy({ saleId: s.saleId, buyerIdentity: identity, buyerPkh: pkh, spentPoolTxid: prep.poolTxid, spentPoolVout: prep.poolVout, buyTxid: bc.txid || built.txid, newPool: built.newPool, delta, cost: prep.cost });
      if (!rec.ok) throw new Error(rec.error);
      setTxid(bc.txid || built.txid); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function doSell() {
    setBusy(true); setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { buildLedgerSellTx } = await import('@launchpad/curve');
      const { PublicKey, P2PKH } = await import('@bsv/sdk');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      const derivation = { protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self' as const };
      const { publicKey: ownerPubHex } = await wallet.getPublicKey(derivation);
      const pkh = Buffer.from(PublicKey.fromString(ownerPubHex).toHash() as number[]).toString('hex');
      const payoutScriptHex = new P2PKH().lock(PublicKey.fromString(ownerPubHex).toAddress()).toHex();

      const prep = await prepareLedgerSell({ saleId: s.saleId, sellerPkh: pkh, amount: delta, payoutScriptHex });
      if (!prep.ok) throw new Error(prep.error);

      // holder authorises: sign the digest with the same derived key
      const digest = Array.from(Buffer.from(prep.digestHex, 'hex')) as number[];
      const sigRes = await wallet.createSignature({ ...derivation, hashToDirectlySign: digest } as never);
      const sigDerHex = Buffer.from(sigRes.signature as number[]).toString('hex');

      const fin = await finalizeLedgerSell({ saleId: s.saleId, sellerPkh: pkh, ownerPubHex, amount: delta, payoutScriptHex, sigDerHex });
      if (!fin.ok) throw new Error(fin.error);

      const built = await buildLedgerSellTx({
        wallet: wallet as never, chain: 'main',
        pool: { txid: prep.poolTxid, vout: prep.poolVout, scriptHex: prep.sourceLockHex, reserveBefore: prep.reserveBefore },
        unlockingHex: fin.unlockingHex, nextLockingHex: fin.nextLockingHex, payoutScriptHex,
        reserveAfter: prep.reserveAfter, refund: prep.refund, sold: pool!.sold, amount: delta,
      });
      if (!built.ok || !built.rawTx || !built.txid || !built.newPool) throw new Error(built.reason ?? 'sell build failed');

      const bc = await broadcastWithParent(built.paymentRawTx, built.paymentTxid, built.rawTx, built.txid);
      if (!bc.ok) throw new Error(`sell broadcast rejected: ${bc.error}`);

      const rec = await recordLedgerSell({ saleId: s.saleId, sellerIdentity: identity, sellerPkh: pkh, spentPoolTxid: prep.poolTxid, spentPoolVout: prep.poolVout, sellTxid: bc.txid || built.txid, newPool: built.newPool, amount: delta, refund: prep.refund });
      if (!rec.ok) throw new Error(rec.error);
      setTxid(bc.txid || built.txid); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="card flex flex-col gap-5 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Trade {s.ticker}</h2>
        <StatusPill status={s.status} />
      </div>
      <div className="flex items-center gap-2 text-sm text-teal">
        <ShieldCheck className="h-4 w-4" /> Trustless curve · buy &amp; sell, on-chain reserve
      </div>

      {pool && (
        <div className="grid grid-cols-3 gap-2 font-mono text-xs">
          <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">sold</div><div className="text-fg">{pool.sold}/{pool.supply}</div></div>
          <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">reserve</div><div className="text-fg">{pool.reserveSats}</div></div>
          <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">you hold</div><div className="text-fg">{myBalance}</div></div>
        </div>
      )}

      <div className="flex gap-2">
        {(['buy', 'sell'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className="chip" data-active={tab === t}>{t === 'buy' ? 'Buy' : 'Sell'}</button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-xs text-faint">
        Tokens to {tab}
        <input type="number" min={1} max={(tab === 'buy' ? remaining : myBalance) || undefined} value={amount}
          onChange={(e) => setAmount(Math.floor(Number(e.target.value)))}
          className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg" />
      </label>

      <div className="flex items-center justify-between font-mono text-sm">
        <span className="text-faint">{tab === 'buy' ? 'cost' : 'you receive'}</span>
        <span className="text-fg">{quote.toLocaleString('en-US')} sats</span>
      </div>

      <Button onClick={tab === 'buy' ? doBuy : doSell} disabled={!open || busy || delta <= 0} block>
        {busy ? 'Working…' : !open ? 'Not open' : tab === 'buy' ? `Buy ${delta} ${s.ticker}` : `Sell ${delta} ${s.ticker}`}
      </Button>

      {txid && <a href={`https://whatsonchain.com/tx/${txid}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-teal underline underline-offset-2">{txid}</a>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
