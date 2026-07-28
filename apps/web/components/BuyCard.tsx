'use client';

import { useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, StatusPill } from './ui';
import { Countdown } from './ui/Countdown';
import { ShieldCheck } from './ui/icons';
import { reserveOrder, confirmOrderPayment } from '../lib/order-actions';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];
const ORIGINATOR = 'launchpad.local';

export function BuyCard({ s }: { s: SaleCardVM }) {
  const [amount, setAmount] = useState(1000);
  const [status, setStatus] = useState<'idle' | 'buying' | 'placed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const tokens = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  const cost = tokens * s.priceSats;
  const live = s.status === 'live';
  const scheduled = s.status === 'scheduled';

  async function buy() {
    setStatus('buying');
    setError(null);
    try {
      if (tokens <= 0) throw new Error('enter an amount');
      const { WalletClient, PublicKey, P2PKH } = await import('@bsv/sdk');
      const wallet = new WalletClient('auto', ORIGINATOR);
      await wallet.waitForAuthentication({});

      const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
      // Buyer's token-receive address = their derived STAS owner key.
      const { publicKey: ownerPub } = await wallet.getPublicKey({
        protocolID: STAS_PROTOCOL,
        keyID: s.slug,
        counterparty: 'self',
      });
      const receiveAddress = PublicKey.fromString(ownerPub).toAddress().toString();

      // Reserve-then-pay (ADR-022): claim the allocation BEFORE paying, so an
      // oversold order is rejected up front instead of leaving a paid buyer to
      // be refunded. The reservation lazily expires if payment never confirms.
      const reserved = await reserveOrder({
        projectId: s.projectId,
        buyerIdentity: identityKey,
        receiveAddress,
        tokens,
      });
      if (!reserved.ok || !reserved.orderId) throw new Error(reserved.error ?? 'could not reserve tokens');

      // Pay the seller. Payment is REQUIRED when the sale has a price — the order
      // only becomes settle-eligible once this is verified on-chain server-side.
      // Broadcast immediately (not delayed) so verification can find it.
      let paymentTxid: string | undefined;
      if (cost > 0) {
        if (!s.payoutAddress) throw new Error('this sale has no payout address configured yet');
        const lockingScript = new P2PKH().lock(s.payoutAddress).toHex();
        const res = (await wallet.createAction({
          description: `Buy ${tokens} ${s.ticker}`.slice(0, 50),
          outputs: [{ lockingScript, satoshis: cost, outputDescription: `pay ${s.ticker} sale`.slice(0, 50) }],
          options: { acceptDelayedBroadcast: false },
        })) as { txid?: string };
        paymentTxid = res?.txid;
        if (!paymentTxid) throw new Error('payment was not completed in the wallet');
      }

      const r = await confirmOrderPayment(reserved.orderId, cost, paymentTxid);
      if (!r.ok) throw new Error(r.error ?? 'order failed');
      setStatus('placed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
    }
  }

  return (
    <div className="sticky top-20 rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow-1)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Price per token</span>
          <span className="font-mono text-2xl font-semibold tabular-nums text-fg">{s.priceSats} sats</span>
        </div>
        <StatusPill status={s.status} />
      </div>

      {s.status !== 'scheduled' && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between font-mono text-xs text-muted">
            <span>Sold</span>
            <span>{s.soldPct}%</span>
          </div>
          <div className="progress">
            <i style={{ width: `${s.soldPct}%` }} />
          </div>
        </div>
      )}

      {s.countdown && (
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-xs uppercase tracking-[0.08em] text-faint">
            {scheduled ? 'Starts in' : 'Ends in'}
          </div>
          <Countdown {...s.countdown} />
        </div>
      )}

      {live && status !== 'placed' && (
        <div className="mt-4">
          <label className="mb-1.5 block font-mono text-xs uppercase tracking-[0.08em] text-faint">
            Amount ({s.ticker})
          </label>
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-full rounded-md border border-line bg-elevated px-3 py-2.5 font-mono tabular-nums text-fg outline-none transition focus:border-gold"
          />
          <div className="mt-2 flex justify-between font-mono text-sm">
            <span className="text-muted">Total</span>
            <span className="tabular-nums text-fg">{cost.toLocaleString('en-US')} sats</span>
          </div>
        </div>
      )}

      <div className="mt-5">
        {live && status === 'placed' ? (
          <div className="rounded-md border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">
            ✓ Order placed — pending settlement. Tokens are delivered to your wallet once the operator settles.
          </div>
        ) : live ? (
          <Button variant="primary" block onClick={buy} disabled={status === 'buying'}>
            {status === 'buying' ? 'Placing order…' : 'Buy on mainnet'}
          </Button>
        ) : scheduled ? (
          <Button variant="secondary" block disabled>
            Not yet open
          </Button>
        ) : (
          <Button variant="secondary" block disabled>
            Sale ended
          </Button>
        )}
      </div>

      {error && <p className="mt-3 break-words text-xs text-danger">{error}</p>}

      <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-teal">
        <ShieldCheck width={14} height={14} /> settlement is SPV-verifiable
      </p>
    </div>
  );
}
