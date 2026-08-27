'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui';
import { useWallet } from './WalletProvider';
import { getSourceBeef, getOutputInfo, broadcastRawTx } from '../lib/settle-actions';
import { markOrderRegistered } from '../lib/order-actions';
import { getMerkleClaimables } from '../lib/merkle-ledger-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

/**
 * The holder's ledger identity. `'self'` is the SAME derivation the rest of the app uses to hold
 * STAS, so a ledger balance and a token balance now live under one key.
 */
const selfDerivation = (slug: string) => ({ protocolID: STAS_PROTOCOL, keyID: slug, counterparty: 'self' as const });

/**
 * The identity earlier pools were keyed to. Kept ONLY so tokens already delivered there can be
 * swept — never used for anything new. It gave each user a second address their wallet controlled
 * but did not display, which is exactly the bug this file now migrates away from.
 */
const legacyDerivation = (slug: string) => ({ protocolID: STAS_PROTOCOL, keyID: slug, counterparty: 'anyone' as const, forSelf: true });

interface Claim { orderId: string; txid: string; tokens: number; slug: string; ticker: string; legacy?: boolean }

/**
 * Register graduated curve tokens into the holder's wallet (ADR-030).
 *
 * Separate from the generic `ClaimTokens` because that one finds a buyer's claims by
 * `buyerIdentity`, and a graduation delivery carries the PROJECT's identity — the project runs the
 * mint. We never learn a holder's identity key at all, only the pkh their ledger balance was keyed
 * to, so the lookup here is by that pkh, which the holder's own wallet re-derives.
 */
export function MerkleClaimTokens({ saleId, slug, graduated }: { saleId: string; slug: string; graduated: boolean }) {
  const { connect } = useWallet();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Both identities: the current one, and the legacy one that may still be holding tokens. */
  const keys = useCallback(async () => {
    await connect();
    const { getWalletClient } = await import('@launchpad/bsv/wallet');
    const { PublicKey, Utils } = await import('@bsv/sdk');
    const wallet = await getWalletClient();
    const hash = (pub: string) => Buffer.from(PublicKey.fromString(pub).toHash() as number[]).toString('hex');
    const { publicKey: selfPub } = await wallet.getPublicKey(selfDerivation(slug) as never);
    const { publicKey: legacyPub } = await wallet.getPublicKey(legacyDerivation(slug) as never);
    const selfPkh = hash(selfPub);
    return {
      wallet, selfPkh, legacyPkh: hash(legacyPub),
      selfAddress: Utils.toBase58Check(Array.from(Buffer.from(selfPkh, 'hex')), [0]),
    };
  }, [connect, slug]);

  const refresh = useCallback(async () => {
    try {
      const { selfPkh, legacyPkh } = await keys();
      const [mine, legacy] = await Promise.all([
        getMerkleClaimables(saleId, selfPkh),
        getMerkleClaimables(saleId, legacyPkh),
      ]);
      setClaims([...mine, ...legacy.map((c) => ({ ...c, legacy: true }))]);
    } catch { /* wallet not connected yet */ }
    finally { setChecked(true); }
  }, [keys, saleId]);
  useEffect(() => { if (graduated) void refresh(); }, [graduated, refresh]);

  async function claim(c: Claim) {
    setBusy(c.orderId); setError(null); setNote(null);
    try {
      const { wallet, selfAddress, legacyPkh } = await keys();
      let txid = c.txid;

      if (c.legacy) {
        // Delivered to the old ledger identity. Move it to the address this wallet actually shows
        // before registering, otherwise it stays invisible in the assets view.
        setNote('moving your tokens to your wallet address…');
        const info = await getOutputInfo(c.txid, 0);
        if (!info) throw new Error('could not read the delivered token output — try again shortly');
        const beef = await getSourceBeef(c.txid);
        const { transferStas } = await import('@launchpad/bsv/settle');
        const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
        const res = await transferStas(wallet as never, identity, 'main', {
          source: {
            txid: c.txid, vout: 0, scriptHex: info.scriptHex, satoshis: info.satoshis,
            brc42KeyId: slug,
            owner: { ...legacyDerivation(slug), forSelf: true },
            beef: beef ?? undefined,
          },
          recipientAddress: selfAddress,
          amount: c.tokens,
          senderChangeHash160: legacyPkh,
        } as never);
        if (!res.ok) throw new Error(res.reason);
        if (res.fundingRawTx) await broadcastRawTx(res.fundingRawTx, res.fundingTxid);
        const bc = await broadcastRawTx(res.rawTx, res.txid);
        if (!bc.ok) throw new Error(`move rejected: ${bc.error}`);
        txid = bc.txid || res.txid;
        setNote('moved — now registering…');
      }

      setNote('fetching the delivery proof…');
      const beef = await getSourceBeef(txid);
      if (!beef) throw new Error('that transaction is not confirmed yet — try again in a few minutes');

      setNote('registering in your wallet (approve if prompted)…');
      const { receiveStasToken } = await import('@launchpad/bsv/receive');
      const res = await receiveStasToken(wallet as never, {
        txid,
        vout: 0, // the recipient token output is always output 0 of a STAS transfer
        atomicBeef: beef,
        customInstructions: JSON.stringify({ ...selfDerivation(c.slug), ticker: c.ticker, tokens: String(c.tokens) }),
        tags: ['launchpad', c.slug, 'graduated-curve'],
      });

      if (res.registered || res.reason === 'already registered') {
        await markOrderRegistered(c.orderId);
        setNote(`${c.tokens} ${c.ticker} registered in your wallet`);
        await refresh();
      } else {
        throw new Error(res.reason ?? 'registration failed');
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(null); }
  }

  if (!graduated) return null;

  return (
    <div className="card flex flex-col gap-3 p-6">
      <h2 className="text-lg font-semibold">Your tokens</h2>
      {claims.length === 0 ? (
        <p className="text-xs text-muted">
          {checked
            ? 'Nothing to register yet. Your balance in the final ledger is permanent and recomputable from the genesis transaction — the project mints and delivers real tokens against it, and they appear here once they do.'
            : 'Connect your wallet to check what you are owed.'}
        </p>
      ) : (
        claims.map((c) => (
          <div key={c.orderId} className="flex flex-col gap-1.5 rounded-md border border-line bg-elevated/40 px-3 py-2.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-fg">{c.tokens.toLocaleString()} {c.ticker}</span>
              <Button onClick={() => claim(c)} disabled={busy !== null}>
                {busy === c.orderId ? 'Working…' : c.legacy ? 'Move to wallet & register' : 'Register in wallet'}
              </Button>
            </div>
            {c.legacy && (
              <p className="text-faint">
                These were delivered to an older holder key, which your wallet controls but does not list. This moves them
                to your wallet address first — one extra transaction.
              </p>
            )}
          </div>
        ))
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
