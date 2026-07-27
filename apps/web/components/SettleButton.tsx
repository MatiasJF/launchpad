'use client';

import { useState } from 'react';
import { Button } from './ui';
import { getOutputScriptHex } from '../lib/settle-actions';

// Canonical STAS owner protocol id (ADR-021). Hardcoded so the client doesn't
// import @launchpad/bsv statically (bsv/stas-js load lazily on transfer).
const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];
const ORIGINATOR = 'launchpad.local';

export function SettleButton({
  symbol,
  slug,
  issuanceTxid,
  supply,
}: {
  symbol: string;
  slug: string;
  issuanceTxid: string;
  supply: number;
}) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState(supply);
  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function transfer() {
    setStatus('working');
    setError(null);
    try {
      if (!recipient.trim()) throw new Error('recipient BSV address required');
      const scriptHex = await getOutputScriptHex(issuanceTxid, 0);
      if (!scriptHex) throw new Error('could not fetch the token output script from WhatsOnChain');

      // Lazy-load the heavy libs so they stay out of the initial bundle.
      const { WalletClient } = await import('@bsv/sdk');
      const { transferStas } = await import('@launchpad/bsv/settle');

      const wallet = new WalletClient('auto', ORIGINATOR);
      await wallet.waitForAuthentication({});
      const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });

      const res = await transferStas(wallet as never, identityKey, 'main', {
        source: {
          txid: issuanceTxid,
          vout: 0,
          scriptHex,
          satoshis: supply,
          brc42KeyId: `${slug}-owner`,
          owner: { protocolID: STAS_PROTOCOL, keyID: `${slug}-owner`, counterparty: 'self', forSelf: false },
        },
        recipientAddress: recipient.trim(),
        amount: Math.max(1, Math.floor(amount)),
        // partial-send change returns to the current owner (this key)
        senderChangeHash160: scriptHex.substring(6, 46),
      });
      if (!res.ok) throw new Error(res.reason);
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
        ✓ transferred · {txid.slice(0, 10)}…
      </a>
    );
  }

  const input = 'rounded-md border border-line bg-elevated px-3 py-2 font-mono text-sm text-fg outline-none transition focus:border-gold';

  return (
    <div className="flex flex-col gap-2">
      <input
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        placeholder="recipient BSV address"
        className={input}
      />
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={supply}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className={`w-28 ${input}`}
        />
        <span className="font-mono text-xs text-faint">{symbol}</span>
        <Button variant="primary" onClick={transfer} disabled={status === 'working'}>
          {status === 'working' ? 'Transferring…' : 'Transfer'}
        </Button>
      </div>
      {error && <p className="break-words text-xs text-danger">{error}</p>}
    </div>
  );
}
