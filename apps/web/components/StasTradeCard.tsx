'use client';

import { useEffect, useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { ShieldCheck } from './ui/icons';
import { useWallet } from './WalletProvider';
import { broadcastRawTx, resolveCurrentPool, getOutputInfo, getSourceBeef } from '../lib/settle-actions';
import {
  getStasPool, prepareStasBuy, recordStasBuy, deliverStasToBuyer,
  prepareStasSell, recordStasSell, finalizeStasSell, getSellerStasDeliveries,
  getPendingStasSells, completePendingStasSell,
  getPendingStasDeliveries, completePendingStasDelivery,
} from '../lib/stas-actions';

// Canonical STAS BRC-42 owner derivation (ADR-021). The buyer receives STAS to
// hash160 of this key, and spends it (on sell) from the SAME key — so it must be
// byte-identical for getPublicKey on both sides. Matches CurveBuyCard/ClaimTokens.
const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

/** Exact linear-curve cost to move `sold` by delta (mirrors the covenant). */
function curveCost(k: number, sold: number, delta: number): number {
  return (k * delta * (2 * sold + delta + 1)) / 2;
}

/**
 * Wallet-held STAS bonding-curve card (ADR-028, Option B). Operator-gated, but the
 * token is REAL wallet STAS:
 *   BUY  — the buyer funds + signs TX-A (reserve buy); the operator then delivers
 *          `delta` STAS from the vault (TX-B). Two sequenced txs.
 *   SELL — the holder returns `delta` STAS to the operator vault (TX1, an ordinary
 *          client STAS transfer); the operator refunds sats at the curve price (TX2).
 * Non-custodial: the wallet signs its own inputs; the operator only co-signs/delivers.
 */
export function StasTradeCard({ s }: { s: SaleCardVM }) {
  const { connect } = useWallet();
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [pool, setPool] = useState<{ sold: number; supply: number; k: number; reserveSats: number } | null>(null);
  const [held, setHeld] = useState(0);
  const [pendingSells, setPendingSells] = useState<{ orderId: string; tokens: number; paymentTxid: string }[]>([]);
  const [pendingBuys, setPendingBuys] = useState<{ orderId: string; tokens: number; paymentTxid: string | null }[]>([]);
  const [amount, setAmount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await getStasPool(s.saleId);
    if (r.ok) setPool({ sold: r.sold, supply: Number(r.supply), k: Number(r.k), reserveSats: r.reserveSats });
    try {
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      const h = await getSellerStasDeliveries({ saleId: s.saleId, sellerIdentity: identity });
      if (h.ok) setHeld(h.held);
      // Surface any stuck sell (STAS returned, refund never completed) so it can be retried.
      const p = await getPendingStasSells(s.saleId, identity);
      if (p.ok) setPendingSells(p.orders);
      // Surface any stuck buy (paid, STAS never delivered) so it can be retried.
      const b = await getPendingStasDeliveries(s.saleId, identity);
      if (b.ok) setPendingBuys(b.orders);
    } catch { /* wallet not connected yet */ }
  }
  useEffect(() => { void refresh(); }, [s.saleId]);

  /** Retry the operator refund for a stuck sell (STAS already returned; delegates to finalize). */
  async function doCompleteRefund(orderId: string) {
    setBusy(true); setError(null); setTxid(null); setNote(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      setNote('operator completing your refund…');
      const fin = await completePendingStasSell({ orderId, sellerIdentity: identity });
      if (!fin.ok || !fin.txid) throw new Error(fin.error ?? 'refund failed');
      setTxid(fin.txid);
      setNote('refunded — sats returned to your address');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  /** Retry the operator STAS delivery for a stuck buy (already paid; delegates to deliver). */
  async function doCompleteDelivery(orderId: string) {
    setBusy(true); setError(null); setTxid(null); setNote(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      setNote('operator delivering your STAS…');
      const del = await completePendingStasDelivery({ orderId, buyerIdentity: identity });
      if (!del.ok || !del.txid) throw new Error(del.error ?? 'delivery failed');
      setTxid(del.txid);
      setNote('delivered — tokens are in your wallet');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  const remaining = pool ? pool.supply - pool.sold : 0;
  const open = s.saleState === 'open' && pool != null;
  const delta = Math.max(0, Math.min(amount, tab === 'buy' ? remaining : held));
  const quote = pool && delta > 0
    ? tab === 'buy' ? curveCost(pool.k, pool.sold, delta) : curveCost(pool.k, pool.sold - delta, delta)
    : 0;

  /** Push TX1 (parent) then the spend, retrying while TX1 propagates. */
  async function broadcastWithParent(parentRaw: string | undefined, parentTxid: string | undefined, rawTx: string, id: string) {
    if (parentRaw) await broadcastRawTx(parentRaw, parentTxid);
    let bc = await broadcastRawTx(rawTx, id);
    for (let i = 0; i < 6 && !bc.ok && /missing inputs/i.test(bc.error ?? ''); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      if (parentRaw) await broadcastRawTx(parentRaw, parentTxid);
      bc = await broadcastRawTx(rawTx, id);
    }
    return bc;
  }

  async function doBuy() {
    setBusy(true); setError(null); setTxid(null); setNote(null);
    try {
      if (delta <= 0) throw new Error('enter a token amount');
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { buildStasBuyTx } = await import('@launchpad/curve');
      const { PublicKey } = await import('@bsv/sdk');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      const { publicKey: ownerPub } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self' });
      const receiveAddress = PublicKey.fromString(ownerPub).toAddress().toString();

      // Sequence against the LATEST pool outpoint.
      const prep = await prepareStasBuy({ saleId: s.saleId, buyerIdentity: identity, delta });
      if (!prep.ok) throw new Error(prep.error);

      setNote('signing your payment…');
      const built = await buildStasBuyTx({ wallet: wallet as never, chain: 'main', pool: prep.pool, delta });
      if (!built.ok) throw new Error(built.reason);

      setNote('broadcasting the reserve buy (TX-A)…');
      const bc = await broadcastWithParent(built.paymentRawTx, built.paymentTxid, built.rawTx, built.txid);
      if (!bc.ok) throw new Error(`buy broadcast rejected: ${bc.error}`);

      const rec = await recordStasBuy({
        saleId: s.saleId, buyerIdentity: identity, receiveAddress,
        spentPoolTxid: prep.pool.txid, spentPoolVout: prep.pool.vout,
        buyTxid: bc.txid || built.txid, newPool: built.newPool, delta, cost: built.cost,
      });
      if (!rec.ok || !rec.orderId) throw new Error(rec.error ?? 'record failed');

      setNote('operator delivering your STAS (TX-B)…');
      const del = await deliverStasToBuyer({ orderId: rec.orderId });
      if (!del.ok || !del.txid) throw new Error(del.error ?? 'delivery failed');

      // Register the delivered STAS into the wallet so it renders + is spendable.
      try {
        const beef = await getSourceBeef(del.txid);
        if (beef) {
          const { receiveStasToken } = await import('@launchpad/bsv/receive');
          await receiveStasToken(wallet as never, {
            txid: del.txid, vout: 0, atomicBeef: beef,
            customInstructions: JSON.stringify({ protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self', ticker: s.ticker }),
            tags: ['launchpad', s.slug],
          });
        }
      } catch { /* registration is a nicety; the STAS is on-chain regardless */ }

      setTxid(del.txid);
      setNote('delivered — tokens are in your wallet');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  async function doSell() {
    setBusy(true); setError(null); setTxid(null); setNote(null);
    try {
      if (delta <= 0) throw new Error('enter a token amount');
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { transferStas } = await import('@launchpad/bsv/settle');
      const { PublicKey } = await import('@bsv/sdk');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      const { publicKey: ownerPub } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self' });
      const sellerAddress = PublicKey.fromString(ownerPub).toAddress().toString();

      // Sequencing anchor + operator vault address (where the STAS is returned).
      const prep = await prepareStasSell({ saleId: s.saleId, sellerIdentity: identity, delta, sellerRefundAddress: sellerAddress });
      if (!prep.ok) throw new Error(prep.error);

      // Find one of this seller's deliveries whose CURRENT (unspent) STAS UTXO covers delta.
      const deliv = await getSellerStasDeliveries({ saleId: s.saleId, sellerIdentity: identity });
      if (!deliv.ok) throw new Error(deliv.error);
      setNote('locating your STAS…');
      let source: { txid: string; vout: number; scriptHex: string; satoshis: number; beef: number[] } | null = null;
      for (const d of [...deliv.deliveries].sort((a, b) => b.tokens - a.tokens)) {
        const cur = await resolveCurrentPool(d.txid); // walks change-back-to-holder to the live UTXO
        if ('error' in cur) continue;
        const info = await getOutputInfo(cur.txid, cur.vout);
        if (!info || info.satoshis < delta) continue;
        const beef = await getSourceBeef(cur.txid);
        if (!beef) continue;
        source = { txid: cur.txid, vout: cur.vout, scriptHex: info.scriptHex, satoshis: info.satoshis, beef };
        break;
      }
      if (!source) throw new Error('no single unspent STAS holding covers that amount — try a smaller amount or a specific buy');

      // TX1 — return `delta` STAS to the operator vault (change back to self).
      setNote('returning your STAS to the vault (TX1)…');
      const res = await transferStas(wallet as never, identity, 'main', {
        source: {
          txid: source.txid, vout: source.vout, scriptHex: source.scriptHex, satoshis: source.satoshis,
          brc42KeyId: s.slug,
          owner: { protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'self', forSelf: false },
          beef: source.beef,
        },
        recipientAddress: prep.vaultAddress,
        amount: delta,
        senderChangeHash160: source.scriptHex.substring(6, 46), // change STAS back to the seller
      });
      if (!res.ok) throw new Error(res.reason);

      const bc = await broadcastWithParent(res.fundingRawTx, res.fundingTxid, res.rawTx, res.txid);
      if (!bc.ok) throw new Error(`STAS return broadcast rejected: ${bc.error}`);
      const returnTxid = bc.txid || res.txid;

      const rec = await recordStasSell({ saleId: s.saleId, sellerIdentity: identity, sellerRefundAddress: sellerAddress, returnTxid, delta });
      if (!rec.ok || !rec.orderId) throw new Error(rec.error ?? 'record failed');

      // TX2 — the operator verifies provenance + refunds sats at the curve price.
      setNote('operator refunding at the curve price (TX2)…');
      const fin = await finalizeStasSell({ orderId: rec.orderId });
      if (!fin.ok || !fin.txid) throw new Error(fin.error ?? 'refund failed');

      setTxid(fin.txid);
      setNote('refunded — sats returned to your address');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  return (
    <div className="card flex flex-col gap-5 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Trade {s.ticker}</h2>
        <StatusPill status={s.status} />
      </div>
      <div className="flex items-center gap-2 text-sm text-teal">
        <ShieldCheck className="h-4 w-4" /> Wallet-held STAS · buy &amp; sell, operator-settled curve
      </div>

      {pool && (
        <div className="grid grid-cols-3 gap-2 font-mono text-xs">
          <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">sold</div><div className="text-fg">{pool.sold}/{pool.supply}</div></div>
          <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">reserve</div><div className="text-fg">{pool.reserveSats}</div></div>
          <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">you hold</div><div className="text-fg">{held}</div></div>
        </div>
      )}

      <div className="flex gap-2">
        {(['buy', 'sell'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className="chip" data-active={tab === t}>{t === 'buy' ? 'Buy' : 'Sell'}</button>
        ))}
      </div>

      {tab === 'buy' && pool && remaining === 0 && (
        <div className="rounded-md border border-line bg-elevated/40 px-3 py-2.5 text-xs text-muted">
          <span className="font-semibold text-fg">Sold out</span> — all {pool.supply} {s.ticker} have been bought. Buying is closed; you can{' '}
          <button type="button" onClick={() => setTab('sell')} className="text-teal underline underline-offset-2">sell your tokens back →</button>
        </div>
      )}

      {tab === 'buy' && pendingBuys.map((o) => (
        <div key={o.orderId} className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-xs">
          <p className="text-fg">
            You paid for <span className="font-mono">{o.tokens}</span> {s.ticker} but delivery didn&apos;t complete. Your payment is recorded — finish the delivery below.
          </p>
          <Button onClick={() => doCompleteDelivery(o.orderId)} disabled={busy} block>
            {busy ? 'Working…' : `Complete delivery of ${o.tokens} ${s.ticker}`}
          </Button>
        </div>
      ))}

      {tab === 'sell' && pendingSells.map((o) => (
        <div key={o.orderId} className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-xs">
          <p className="text-fg">
            You returned <span className="font-mono">{o.tokens}</span> {s.ticker} to the vault but the refund didn&apos;t complete. Your sats are safe — finish the refund below.
          </p>
          <Button onClick={() => doCompleteRefund(o.orderId)} disabled={busy} block>
            {busy ? 'Working…' : `Complete refund of ${o.tokens} ${s.ticker}`}
          </Button>
        </div>
      ))}

      <label className="flex flex-col gap-1 text-xs text-faint">
        Tokens to {tab}
        <input type="number" min={1} max={(tab === 'buy' ? remaining : held) || undefined} value={amount}
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

      {note && <p className="font-mono text-xs text-muted">⏳ {note}</p>}
      {txid && <a href={`https://whatsonchain.com/tx/${txid}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-teal underline underline-offset-2">{txid}</a>}
      {error && <p className="break-words text-sm text-danger">{error}</p>}
    </div>
  );
}
