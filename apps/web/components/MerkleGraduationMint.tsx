'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui';
import { useWallet } from './WalletProvider';
import { broadcastRawTx, resolveCurrentPool, getOutputInfo, getSourceBeefDeep } from '../lib/settle-actions';
import { getMerkleFinalLedger, prepareMerkleMint, recordMerkleMint, recordMerkleDelivery } from '../lib/merkle-ledger-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

interface Entry { ownerPkh: string; amount: number; deliveredTxid: string | null }

/**
 * Owner-only: turn a GRADUATED pool's final ledger into wallet-held STAS.
 *
 * This is the one step in the trustless curve that the covenant does NOT enforce. Before
 * graduation the chain guarantees price, custody and refund; after it, the project holds the sats
 * and the holders hold ledger entries, and nothing compels this mint. Atomic mint-at-graduation is
 * impossible — a STAS token input may carry only token outputs plus one change output, so real
 * tokens cannot ride the covenant spend (ADR-029).
 *
 * What that leaves is accountability rather than enforcement: the mint list below is recomputed
 * from the genesis transaction every time this loads, so the debt is permanent, public, and
 * verifiable by any holder without the project's cooperation. The UI says so instead of implying
 * the chain has this covered.
 */
export function MerkleGraduationMint({ saleId, slug, ticker, name, description, logoUrl, website }: {
  saleId: string; slug: string; ticker: string;
  name?: string; description?: string | null; logoUrl?: string | null; website?: string | null;
}) {
  const { connect } = useWallet();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [graduated, setGraduated] = useState(false);
  const [issuanceTxid, setIssuanceTxid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const symbol = ticker.replace(/^\$/, '');

  const refresh = useCallback(async () => {
    const r = await getMerkleFinalLedger(saleId);
    if (r.ok) {
      setEntries(r.entries); setTotal(r.total); setGraduated(r.graduated); setIssuanceTxid(r.issuanceTxid);
    }
  }, [saleId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const pending = entries.filter((e) => !e.deliveredTxid && e.amount > 0);

  async function mint() {
    setBusy(true); setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });

      const prep = await prepareMerkleMint({ saleId, identityPubkey: identity });
      if (!prep.ok) throw new Error(prep.error);

      setNote(`issuing ${prep.total} ${ticker} against the final ledger…`);
      const { issueStasGenesis } = await import('@launchpad/bsv/genesis');
      // Minted to the OWNER's own key — no operator vault is involved on this track.
      const { publicKey: ownerPubHex } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: slug, counterparty: 'self' } as never);
      const res = await issueStasGenesis(wallet as never, '', 'main', {
        slug, symbol, supply: prep.total, splittable: true,
        name, description: description ?? undefined, image: logoUrl ?? undefined, website: website ?? undefined,
        ownerPubHex,
      });
      if (!res.ok) throw new Error(res.reason);

      const bc1 = await broadcastRawTx(res.contractRawTx, res.contractTxid);
      if (!bc1.ok) throw new Error(`contract broadcast rejected: ${bc1.error}`);
      const bc2 = await broadcastRawTx(res.issueRawTx, res.genesisTxid);
      if (!bc2.ok) throw new Error(`issue broadcast rejected: ${bc2.error}`);

      const rec = await recordMerkleMint({ saleId, identityPubkey: identity, issuanceTxid: bc2.txid || res.genesisTxid, tokenId: res.tokenId });
      if (!rec.ok) throw new Error(rec.error);
      setIssuanceTxid(bc2.txid || res.genesisTxid);
      setNote('minted — give it a few seconds to propagate, then deliver to each holder below');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  /** Deliver one holder's balance. Sequential on purpose — each send moves the token UTXO. */
  async function deliver(entry: Entry) {
    setBusy(true); setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { transferStas } = await import('@launchpad/bsv/settle');
      const { Utils } = await import('@bsv/sdk');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });

      // A freshly-broadcast issuance is not immediately readable: WhatsOnChain indexes it a few
      // seconds later, and the first version of this shipped with no wait at all, so clicking
      // Deliver right after Mint failed with a bare "could not read the token output" that said
      // nothing about why. Retry, and name the real cause if it never appears.
      setNote('resolving the token UTXO…');
      let cur: { txid: string; vout: number } | null = null;
      let info: { scriptHex: string; satoshis: number } | null = null;
      for (let i = 0; i < 8 && !info; i++) {
        const r = await resolveCurrentPool(issuanceTxid!);
        if (!('error' in r)) {
          cur = r;
          info = await getOutputInfo(r.txid, r.vout);
        }
        if (!info) {
          setNote(`waiting for the issuance to propagate… (${i + 1}/8)`);
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
      if (!cur || !info) {
        throw new Error('the issuance is not visible on-chain yet — wait a few seconds and click Deliver again');
      }
      const beef = await getSourceBeefDeep(cur.txid);

      // A holder's ledger identity IS a pkh, so the STAS goes to that same P2PKH address —
      // the one their derived key already controls. Round-trips against `Utils.fromBase58Check`,
      // which is what the actions use to go the other way.
      const addr = Utils.toBase58Check(Array.from(Buffer.from(entry.ownerPkh, 'hex')), [0]);

      setNote(`sending ${entry.amount} ${ticker} to ${entry.ownerPkh.slice(0, 10)}…`);
      const res = await transferStas(wallet as never, identity, 'main', {
        source: {
          txid: cur.txid, vout: cur.vout, scriptHex: info.scriptHex, satoshis: info.satoshis,
          brc42KeyId: slug,
          owner: { protocolID: STAS_PROTOCOL, keyID: slug, counterparty: 'self', forSelf: false },
          beef: beef ?? undefined,
        },
        recipientAddress: addr,
        amount: entry.amount,
        senderChangeHash160: info.scriptHex.substring(6, 46),
      } as never);
      if (!res.ok) throw new Error(res.reason);

      if (res.fundingRawTx) await broadcastRawTx(res.fundingRawTx, res.fundingTxid);
      const bc = await broadcastRawTx(res.rawTx, res.txid);
      if (!bc.ok) throw new Error(`delivery broadcast rejected: ${bc.error}`);

      const rec = await recordMerkleDelivery({ saleId, identityPubkey: identity, ownerPkh: entry.ownerPkh, amount: entry.amount, txid: bc.txid || res.txid });
      if (!rec.ok) throw new Error(rec.error);
      setNote(`delivered ${entry.amount} ${ticker}`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(false); }
  }

  if (!graduated) return null;

  return (
    <div className="card flex flex-col gap-4 p-6">
      <h2 className="text-lg font-semibold">Graduated — settle up with holders</h2>

      <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-fg">
        <span className="font-semibold">This step is not enforced by the covenant.</span> Everything up to graduation was —
        price, custody, refunds, and the reserve only ever reaching your payout address. This is a promise instead: you have
        the sats, and holders have entries. The list below is recomputed from the genesis transaction every time it loads,
        so the debt is permanent and any holder can prove it without your cooperation — but nothing on-chain forces you to
        mint. Doing it promptly is what makes the next sale credible.
      </div>

      <div className="flex flex-col gap-1 font-mono text-xs">
        <div className="text-faint">final ledger · {total.toLocaleString()} {ticker} owed to {entries.length} holder(s)</div>
        {entries.map((e) => (
          <div key={e.ownerPkh} className="flex items-center justify-between rounded-md border border-line bg-elevated/40 px-2 py-1.5">
            <span className="text-muted">{e.ownerPkh.slice(0, 16)}…</span>
            <span className="text-fg">{e.amount.toLocaleString()}</span>
            {e.deliveredTxid ? (
              <a className="text-teal underline underline-offset-2" href={`https://whatsonchain.com/tx/${e.deliveredTxid}`} target="_blank" rel="noreferrer">delivered ↗</a>
            ) : issuanceTxid ? (
              <Button onClick={() => deliver(e)} disabled={busy}>{busy ? '…' : 'Deliver'}</Button>
            ) : (
              <span className="text-faint">awaiting mint</span>
            )}
          </div>
        ))}
      </div>

      {!issuanceTxid ? (
        <Button onClick={mint} disabled={busy || total <= 0} block>
          {busy ? 'Minting…' : `Mint ${total.toLocaleString()} ${ticker} for holders`}
        </Button>
      ) : (
        <p className="text-xs text-muted">
          {pending.length === 0
            ? 'All holders delivered. They can register the tokens into their wallet from the sale page.'
            : `${pending.length} holder(s) still to deliver.`}
        </p>
      )}

      {issuanceTxid && (
        <a className="font-mono text-xs text-teal underline underline-offset-2" href={`https://whatsonchain.com/tx/${issuanceTxid}`} target="_blank" rel="noreferrer">
          issuance {issuanceTxid.slice(0, 20)}… ↗
        </a>
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
