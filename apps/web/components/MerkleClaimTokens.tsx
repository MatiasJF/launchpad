'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui';
import { useWallet } from './WalletProvider';
import { getSourceBeef } from '../lib/settle-actions';
import { markOrderRegistered } from '../lib/order-actions';
import { getMerkleClaimables } from '../lib/merkle-ledger-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

interface Claim { orderId: string; txid: string; tokens: number; slug: string; ticker: string }

/**
 * Register graduated curve tokens into the holder's wallet (ADR-030).
 *
 * A separate card from the generic `ClaimTokens` for one substantive reason: that one finds a
 * buyer's claims by `buyerIdentity`, and a graduation delivery does not carry the holder's identity
 * — the PROJECT runs the mint, so the Order carries theirs. We never learn a holder's identity key
 * at all, only the pkh their ledger balance was keyed to. So the lookup here is by that pkh, which
 * the holder's own wallet re-derives on demand.
 *
 * Before the project mints there is genuinely nothing to claim, and the card says that plainly
 * rather than showing "no settled orders", which told a holder of 60 tokens they had none.
 */
export function MerkleClaimTokens({ saleId, slug, graduated }: { saleId: string; slug: string; graduated: boolean }) {
  const { connect } = useWallet();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** The holder's ledger pkh — the SAME derivation the trade card used to hold the balance. */
  const myPkh = useCallback(async () => {
    await connect();
    const { getWalletClient } = await import('@launchpad/bsv/wallet');
    const { PublicKey } = await import('@bsv/sdk');
    const wallet = await getWalletClient();
    const { publicKey } = await wallet.getPublicKey({
      protocolID: STAS_PROTOCOL, keyID: slug, counterparty: 'anyone', forSelf: true,
    } as never);
    return { wallet, pkh: Buffer.from(PublicKey.fromString(publicKey).toHash() as number[]).toString('hex') };
  }, [connect, slug]);

  const refresh = useCallback(async () => {
    try {
      const { pkh } = await myPkh();
      setClaims(await getMerkleClaimables(saleId, pkh));
    } catch { /* wallet not connected yet */ }
    finally { setChecked(true); }
  }, [myPkh, saleId]);
  useEffect(() => { if (graduated) void refresh(); }, [graduated, refresh]);

  async function claim(c: Claim) {
    setBusy(c.orderId); setError(null); setNote(null);
    try {
      const { wallet } = await myPkh();
      setNote('fetching the delivery proof…');
      const beef = await getSourceBeef(c.txid);
      if (!beef) throw new Error('the delivery transaction is not confirmed yet — try again in a few minutes');

      setNote('registering in your wallet (approve if prompted)…');
      const { receiveStasToken } = await import('@launchpad/bsv/receive');
      const res = await receiveStasToken(wallet as never, {
        txid: c.txid,
        vout: 0, // the recipient token output is always output 0 of a STAS transfer
        atomicBeef: beef,
        customInstructions: JSON.stringify({
          protocolID: STAS_PROTOCOL, keyID: c.slug, counterparty: 'anyone', forSelf: true,
          ticker: c.ticker, tokens: String(c.tokens),
        }),
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
          <div key={c.orderId} className="flex items-center justify-between gap-3 rounded-md border border-line bg-elevated/40 px-3 py-2.5 text-xs">
            <span className="font-mono text-fg">{c.tokens.toLocaleString()} {c.ticker}</span>
            <Button onClick={() => claim(c)} disabled={busy !== null}>
              {busy === c.orderId ? 'Registering…' : 'Register in wallet'}
            </Button>
          </div>
        ))
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
