'use client';

import { useState } from 'react';
import { Button } from './ui';
import { getOutputInfo, getSourceBeef } from '../lib/settle-actions';
import { markOrderSettled } from '../lib/order-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];
const ORIGINATOR = 'launchpad.local';

export function SettleOrderButton({
  orderId,
  slug,
  receiveAddress,
  tokens,
  defaultTxid,
}: {
  orderId: string;
  slug: string;
  receiveAddress: string;
  tokens: number;
  defaultTxid: string;
}) {
  // The pool UTXO to spend from. It moves after each partial send, so the
  // operator points this at the CURRENT pool UTXO (auto-tracking is a follow-up).
  // The balance is fetched from-chain so it always matches.
  const [srcTxid, setSrcTxid] = useState(defaultTxid);
  const [srcVout, setSrcVout] = useState(0);
  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function settle() {
    setStatus('working');
    setError(null);
    try {
      const info = await getOutputInfo(srcTxid, srcVout);
      if (!info) throw new Error('could not fetch the pool UTXO (script + balance) — is it confirmed & unspent?');
      if (tokens > info.satoshis) throw new Error(`pool holds ${info.satoshis} tokens; order needs ${tokens}`);

      // Ancestry BEEF for the pool UTXO, fetched from-chain (with merkle proof).
      // Required so we can spend a pool UTXO that isn't in the wallet basket
      // (e.g. token change from an earlier transfer).
      const sourceBeef = await getSourceBeef(srcTxid);
      if (!sourceBeef) throw new Error('could not fetch source BEEF — the pool tx must be confirmed (mined) to settle');

      const { WalletClient } = await import('@bsv/sdk');
      const { transferStas } = await import('@launchpad/bsv/settle');
      const wallet = new WalletClient('auto', ORIGINATOR);
      await wallet.waitForAuthentication({});
      const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });

      const res = await transferStas(wallet as never, identityKey, 'main', {
        source: {
          txid: srcTxid,
          vout: srcVout,
          scriptHex: info.scriptHex,
          satoshis: info.satoshis,
          beef: sourceBeef,
          brc42KeyId: `${slug}-owner`,
          owner: { protocolID: STAS_PROTOCOL, keyID: `${slug}-owner`, counterparty: 'self', forSelf: false },
        },
        recipientAddress: receiveAddress,
        amount: Math.max(1, Math.floor(tokens)),
        senderChangeHash160: info.scriptHex.substring(6, 46),
      });
      if (!res.ok) throw new Error(res.reason);
      await markOrderSettled(orderId, res.txid);
      setTxid(res.txid);
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
    }
  }

  if (status === 'done' && txid) {
    return (
      <a
        href={`https://whatsonchain.com/tx/${txid}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs text-teal underline underline-offset-2"
      >
        ✓ settled · {txid.slice(0, 10)}…
      </a>
    );
  }

  const inp = 'rounded-md border border-line bg-elevated px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-gold';

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">
        current pool UTXO (txid · vout) — balance auto-fetched
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <input value={srcTxid} onChange={(e) => setSrcTxid(e.target.value)} placeholder="pool txid" className={`w-64 ${inp}`} />
        <input type="number" value={srcVout} onChange={(e) => setSrcVout(Number(e.target.value))} className={`w-16 ${inp}`} title="vout" />
        <Button variant="primary" onClick={settle} disabled={status === 'working'}>
          {status === 'working' ? 'Settling…' : `Settle ${tokens}`}
        </Button>
      </div>
      {error && <p className="break-words text-xs text-danger">{error}</p>}
    </div>
  );
}
