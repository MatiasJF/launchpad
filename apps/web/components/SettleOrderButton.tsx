'use client';

import { useState } from 'react';
import { Button } from './ui';
import { getOutputScriptHex } from '../lib/settle-actions';
import { markOrderSettled } from '../lib/order-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];
const ORIGINATOR = 'launchpad.local';

export function SettleOrderButton({
  orderId,
  slug,
  receiveAddress,
  tokens,
  defaultTxid,
  defaultSats,
}: {
  orderId: string;
  slug: string;
  receiveAddress: string;
  tokens: number;
  defaultTxid: string;
  defaultSats: number;
}) {
  // The pool UTXO to spend from (moves after each partial send — set it manually
  // for now; auto-tracking is a follow-up).
  const [srcTxid, setSrcTxid] = useState(defaultTxid);
  const [srcVout, setSrcVout] = useState(0);
  const [srcSats, setSrcSats] = useState(defaultSats);
  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function settle() {
    setStatus('working');
    setError(null);
    try {
      const scriptHex = await getOutputScriptHex(srcTxid, srcVout);
      if (!scriptHex) throw new Error('could not fetch the pool UTXO script from WhatsOnChain');

      const { WalletClient } = await import('@bsv/sdk');
      const { transferStas } = await import('@launchpad/bsv/settle');
      const wallet = new WalletClient('auto', ORIGINATOR);
      await wallet.waitForAuthentication({});
      const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });

      const res = await transferStas(wallet as never, identityKey, 'main', {
        source: {
          txid: srcTxid,
          vout: srcVout,
          scriptHex,
          satoshis: srcSats,
          brc42KeyId: `${slug}-owner`,
          owner: { protocolID: STAS_PROTOCOL, keyID: `${slug}-owner`, counterparty: 'self', forSelf: false },
        },
        recipientAddress: receiveAddress,
        amount: Math.max(1, Math.floor(tokens)),
        senderChangeHash160: scriptHex.substring(6, 46),
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
      <div className="flex flex-wrap items-center gap-2">
        <input value={srcTxid} onChange={(e) => setSrcTxid(e.target.value)} placeholder="pool txid" className={`w-64 ${inp}`} />
        <input type="number" value={srcVout} onChange={(e) => setSrcVout(Number(e.target.value))} className={`w-16 ${inp}`} title="vout" />
        <input type="number" value={srcSats} onChange={(e) => setSrcSats(Number(e.target.value))} className={`w-24 ${inp}`} title="pool token balance" />
        <Button variant="primary" onClick={settle} disabled={status === 'working'}>
          {status === 'working' ? 'Settling…' : 'Settle'}
        </Button>
      </div>
      {error && <p className="break-words text-xs text-danger">{error}</p>}
    </div>
  );
}
