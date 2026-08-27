'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { ShieldCheck } from './ui/icons';
import { Button, NumberField, StatusPill } from './ui';
import { useWallet } from './WalletProvider';
import { broadcastRawTx } from '../lib/settle-actions';
import {
  getMerklePool, prepareMerkleBuy, prepareMerkleSell, finalizeMerkleSell,
  prepareMerkleGraduate, recordMerkleTrade, recordMerkleGraduate,
} from '../lib/merkle-ledger-actions';

// Canonical STAS BRC-42 protocol id (ADR-021), reused as the per-sale holder-key namespace.
const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

type Tab = 'buy' | 'sell';

interface PoolView {
  poolTxid: string; poolVout: number; scriptHex: string;
  reserveSats: number; sold: number; supply: string; k: string;
  holderCount: number; graduated: boolean; genesisTxid: string;
  balances: { ownerPkh: string; amount: number }[];
}

/**
 * Buyer + holder card for the TRUSTLESS curve (ADR-030).
 *
 * Every number here is read from the blockchain, not from our database, and every trade is settled
 * by the covenant rather than by us:
 *   BUY   keyless — nobody signs the credit; the covenant prices it and requires the reserve to grow
 *   SELL  the holder's own signature IS their claim to the balance; there is no operator co-signature
 *   GRAD  once sold out, ANYONE may release the reserve to the address fixed at deploy
 *
 * On a contention loss the covenant rejects the spend and we simply rebuild against the new tip —
 * re-priced, because the curve moved. That is surfaced to the user rather than hidden.
 */
export function MerkleTradeCard({ s }: { s: SaleCardVM }) {
  const { connect } = useWallet();
  const [tab, setTab] = useState<Tab>('buy');
  const [pool, setPool] = useState<PoolView | null>(null);
  const [myPkh, setMyPkh] = useState<string | null>(null);
  const [amount, setAmount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await getMerklePool(s.saleId);
    setPool('ok' in r && r.ok ? (r as unknown as PoolView) : null);
  }, [s.saleId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const held = pool && myPkh ? (pool.balances.find((b) => b.ownerPkh.toLowerCase() === myPkh.toLowerCase())?.amount ?? 0) : 0;
  const remaining = pool ? Number(pool.supply) - pool.sold : 0;
  const k = pool ? Number(pool.k) : 1;

  /** Curve quotes, computed exactly as the covenant does so the shown price is the paid price. */
  const quoteBuy = (d: number) => (pool ? (k * d * (2 * pool.sold + d + 1)) / 2 : 0);
  const quoteSell = (a: number) => (pool ? (k * a * (2 * (pool.sold - a) + a + 1)) / 2 : 0);

  /**
   * The holder's ledger identity for THIS pool: a per-sale derived key, not the wallet's identity
   * key. `getPublicKey` and `createSignature` must use the SAME derivation or the covenant's
   * checkSig fails — counterparty 'anyone' + forSelf is the combination proven on mainnet
   * (packages/bsv settle/twoTx/p2pkhInput.ts), and it is what LedgerTradeCard uses too.
   */
  async function holder() {
    await connect();
    const { getWalletClient } = await import('@launchpad/bsv/wallet');
    const { PublicKey } = await import('@bsv/sdk');
    const wallet = await getWalletClient();
    const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
    const derivation = { protocolID: STAS_PROTOCOL, keyID: s.slug, counterparty: 'anyone' as const, forSelf: true };
    const { publicKey: ownerPubHex } = await wallet.getPublicKey(derivation as never);
    const pkh = Buffer.from(PublicKey.fromString(ownerPubHex).toHash() as number[]).toString('hex');
    setMyPkh(pkh);
    return { wallet, identity, derivation, ownerPubHex, pkh };
  }
  // Learn the holder's pkh once, so a balance renders before any trade. Intentionally not in a
  // dependency array: `holder()` prompts the wallet, and re-running it on every render would
  // pester the user.
  const [identified, setIdentified] = useState(false);
  useEffect(() => {
    if (identified) return;
    setIdentified(true);
    void holder().catch(() => {});
  }, [identified]);

  async function broadcastWithParent(parentRaw: string, parentTxid: string, rawTx: string, id: string) {
    if (parentRaw) await broadcastRawTx(parentRaw, parentTxid);
    return broadcastRawTx(rawTx, id);
  }

  async function doBuy() {
    setBusy(true); setError(null); setNote(null); setTxid(null);
    try {
      const { wallet, identity, pkh } = await holder();
      setNote('pricing against the live pool…');
      const prep = await prepareMerkleBuy({ saleId: s.saleId, buyerPkh: pkh, delta: amount });
      if (!prep.ok) throw new Error(prep.error);

      setNote(`paying ${prep.cost.toLocaleString()} sats into the covenant…`);
      const { buildLedgerBuyTx } = await import('@launchpad/curve');
      const built = await buildLedgerBuyTx({
        wallet: wallet as never, chain: 'main',
        pool: { txid: prep.poolTxid, vout: prep.poolVout, scriptHex: prep.sourceLockHex, reserveBefore: prep.reserveBefore },
        unlockingHex: prep.unlockingHex, nextLockingHex: prep.nextLockingHex,
        newReserve: prep.newReserve, cost: prep.cost, sold: prep.sold, delta: amount,
        feeSats: 300, // ADR-031: ~24.7KB at the calibrated 0.01 sat/B
      });
      if (!built.ok) throw new Error(built.reason);

      const bc = await broadcastWithParent(built.paymentRawTx ?? '', built.paymentTxid ?? '', built.rawTx!, built.txid!);
      if (!bc.ok) throw new Error(contentionHint(bc.error));
      await recordMerkleTrade({ saleId: s.saleId, identity, ownerPkh: pkh, kind: 'curve_buy', tokens: amount, sats: prep.cost, txid: bc.txid || built.txid! });
      setTxid(bc.txid || built.txid!);
      setNote(`bought ${amount} ${s.ticker} — your balance lives in the covenant`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  async function doSell() {
    setBusy(true); setError(null); setNote(null); setTxid(null);
    try {
      const { wallet, identity, derivation, ownerPubHex, pkh } = await holder();
      const { PublicKey, P2PKH } = await import('@bsv/sdk');
      const payoutScriptHex = new P2PKH().lock(PublicKey.fromString(ownerPubHex).toAddress()).toHex();
      setNote('quoting the curve refund…');
      const prep = await prepareMerkleSell({ saleId: s.saleId, sellerPkh: pkh, amount, payoutScriptHex });
      if (!prep.ok) throw new Error(prep.error);

      // The holder signs the digest themselves — this signature IS the claim to the balance.
      setNote('sign to authorise the debit (only you can)…');
      const digest = Array.from(Buffer.from(prep.digestHex, 'hex')) as number[];
      const sigRes = await wallet.createSignature({ ...derivation, hashToDirectlySign: digest } as never);
      const sigDerHex = Buffer.from(sigRes.signature as number[]).toString('hex');

      const fin = await finalizeMerkleSell({ saleId: s.saleId, sellerPkh: pkh, ownerPubHex, amount, payoutScriptHex: prep.payoutScriptHex, sigDerHex });
      if (!fin.ok) throw new Error(fin.error);

      setNote(`returning ${prep.refund.toLocaleString()} sats to you…`);
      const { buildLedgerSellTx } = await import('@launchpad/curve');
      const built = await buildLedgerSellTx({
        wallet: wallet as never, chain: 'main',
        pool: { txid: prep.poolTxid, vout: prep.poolVout, scriptHex: fin.sourceLockHex, reserveBefore: prep.reserveBefore },
        unlockingHex: fin.unlockingHex, nextLockingHex: fin.nextLockingHex, payoutScriptHex: prep.payoutScriptHex,
        reserveAfter: prep.reserveAfter, refund: prep.refund, sold: pool!.sold, amount,
        // the covenant pins exactly two outputs, so this input is consumed WHOLE — it must be exact
        feeSats: prep.feeInputSats,
      });
      if (!built.ok) throw new Error(built.reason);

      const bc = await broadcastWithParent(built.paymentRawTx ?? '', built.paymentTxid ?? '', built.rawTx!, built.txid!);
      if (!bc.ok) throw new Error(contentionHint(bc.error));
      await recordMerkleTrade({ saleId: s.saleId, identity, ownerPkh: pkh, kind: 'curve_sell', tokens: amount, sats: prep.refund, txid: bc.txid || built.txid! });
      setTxid(bc.txid || built.txid!);
      setNote(`sold ${amount} ${s.ticker} — ${prep.refund.toLocaleString()} sats returned`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  async function doGraduate() {
    setBusy(true); setError(null); setNote(null);
    try {
      const { wallet } = await holder();
      const prep = await prepareMerkleGraduate({ saleId: s.saleId });
      if (!prep.ok) throw new Error(prep.error);
      setNote(`releasing ${prep.reserve.toLocaleString()} sats to the committed payout…`);
      const { buildLedgerGraduateTx } = await import('@launchpad/curve');
      const built = await buildLedgerGraduateTx({
        wallet: wallet as never, chain: 'main',
        pool: { txid: prep.poolTxid, vout: prep.poolVout, scriptHex: prep.sourceLockHex, reserveBefore: prep.reserve },
        unlockingHex: prep.unlockingHex, payoutScriptHex: prep.payoutScriptHex, reserve: prep.reserve,
        feeSats: 200,
      });
      if (!built.ok) throw new Error(built.reason);
      const bc = await broadcastWithParent(built.paymentRawTx ?? '', built.paymentTxid ?? '', built.rawTx!, built.txid!);
      if (!bc.ok) throw new Error(contentionHint(bc.error));
      await recordMerkleGraduate({ saleId: s.saleId, graduateTxid: bc.txid || built.txid! });
      setTxid(bc.txid || built.txid!);
      setNote('graduated — the reserve went to the address fixed at deploy');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  /** Turn a node's outpoint-conflict into something a person can act on. */
  function contentionHint(msg?: string): string {
    if (msg && /txn-mempool-conflict|missing inputs|258/i.test(msg)) {
      return 'someone else traded first, so the price moved — check the new quote and try again';
    }
    return msg ?? 'broadcast rejected';
  }

  const cost = quoteBuy(amount);
  const refund = quoteSell(Math.min(amount, held));
  const DUST = 546;

  return (
    <div className="card flex flex-col gap-5 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Trade {s.ticker}</h2>
        <StatusPill status={pool?.graduated ? 'finalized' : s.status} />
      </div>
      <div className="flex items-center gap-2 text-sm text-teal">
        <ShieldCheck className="h-4 w-4" /> Trustless curve · no operator can stop, censor or reprice a trade
      </div>

      {!pool && <p className="text-sm text-muted">Reading the pool from the blockchain…</p>}

      {pool && (
        <>
          <div className="grid grid-cols-4 gap-2 font-mono text-xs">
            <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">sold</div><div className="text-fg">{pool.sold}/{pool.supply}</div></div>
            <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">reserve</div><div className="text-fg">{pool.reserveSats.toLocaleString()}</div></div>
            <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">holders</div><div className="text-fg">{pool.holderCount}</div></div>
            <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">you hold</div><div className="text-fg">{held}</div></div>
          </div>

          {pool.graduated ? (
            <div className="rounded-md border border-line bg-elevated/40 px-3 py-2.5 text-xs text-muted">
              <span className="font-semibold text-fg">Graduated</span> — the curve sold out and the reserve was released to
              the payout address fixed at deploy. The final ledger stays readable on-chain.
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                {(['buy', 'sell'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setTab(t)} className="chip" data-active={tab === t}>
                    {t === 'buy' ? 'Buy' : 'Sell'}
                  </button>
                ))}
              </div>

              {tab === 'buy' && remaining === 0 && (
                <div className="rounded-md border border-line bg-elevated/40 px-3 py-2.5 text-xs text-muted">
                  <span className="font-semibold text-fg">Sold out</span> — buying is closed. Anyone can now{' '}
                  <button type="button" onClick={doGraduate} disabled={busy} className="text-teal underline underline-offset-2">
                    release the reserve to the project →
                  </button>
                </div>
              )}

              {tab === 'buy' && remaining > 0 && (
                <>
                  <label className="flex flex-col gap-1 text-xs text-faint">how many {s.ticker}
                    <NumberField value={amount} min={1} max={remaining} onValueChange={setAmount} />
                  </label>
                  <p className="font-mono text-xs text-faint">
                    costs {cost.toLocaleString()} sats · the covenant enforces this price, not us
                  </p>
                  <Button onClick={doBuy} disabled={busy || amount < 1 || amount > remaining} block>
                    {busy ? 'Working…' : `Buy ${amount} ${s.ticker}`}
                  </Button>
                </>
              )}

              {tab === 'sell' && (
                held === 0 ? (
                  <p className="text-xs text-muted">You hold none of this curve yet.</p>
                ) : (
                  <>
                    <label className="flex flex-col gap-1 text-xs text-faint">how many {s.ticker}
                      <NumberField value={Math.min(amount, held)} min={1} max={held} onValueChange={setAmount} />
                    </label>
                    <p className="font-mono text-xs text-faint">
                      returns {refund.toLocaleString()} sats
                      {refund < DUST && <span className="text-warning"> · below the {DUST}-sat dust floor, sell more at once</span>}
                    </p>
                    <Button onClick={doSell} disabled={busy || held === 0 || refund < DUST} block>
                      {busy ? 'Working…' : `Sell ${Math.min(amount, held)} ${s.ticker}`}
                    </Button>
                  </>
                )
              )}
            </>
          )}

          <a className="font-mono text-[11px] text-faint underline underline-offset-2" href={`https://whatsonchain.com/tx/${pool.genesisTxid}`} target="_blank" rel="noreferrer">
            verify this pool yourself from genesis {pool.genesisTxid.slice(0, 16)}… ↗
          </a>
        </>
      )}

      {note && <p className="text-xs text-muted">{note}</p>}
      {txid && (
        <a className="font-mono text-xs text-teal underline underline-offset-2" href={`https://whatsonchain.com/tx/${txid}`} target="_blank" rel="noreferrer">
          {txid.slice(0, 24)}… ↗
        </a>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
