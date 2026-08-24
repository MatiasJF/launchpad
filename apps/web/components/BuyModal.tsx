'use client';

import { useState } from 'react';
import type { SaleCardVM } from '../lib/types';
import { Button, NumberField } from './ui';
import { reserveOrder, confirmOrderPayment } from '../lib/order-actions';
import { useWallet } from './WalletProvider';
import { downloadBeefFromWoc } from '../lib/download-beef';

const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

type Step = 'connect' | 'amount' | 'confirm' | 'processing' | 'success';

interface BuyModalProps {
  s: SaleCardVM;
  isOpen: boolean;
  onClose: () => void;
}

export function BuyModal({ s, isOpen, onClose }: BuyModalProps) {
  const { connect, status } = useWallet();
  const [step, setStep] = useState<Step>(status === 'connected' ? 'amount' : 'connect');
  const [amount, setAmount] = useState(1000);
  const [error, setError] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState('');
  const [paymentTxid, setPaymentTxid] = useState<string | null>(null);
  const [downloadingBeef, setDownloadingBeef] = useState(false);

  const tokens = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  const cost = tokens * s.priceSats;

  // Reset modal state when closed
  function handleClose() {
    setStep(status === 'connected' ? 'amount' : 'connect');
    setAmount(1000);
    setError(null);
    setProcessingStatus('');
    setPaymentTxid(null);
    setDownloadingBeef(false);
    onClose();
  }

  async function handleDownloadProof() {
    if (!paymentTxid) return;
    setDownloadingBeef(true);
    setError(null);

    const result = await downloadBeefFromWoc(paymentTxid, 'main', `launchpad-${s.ticker}-payment-${paymentTxid.slice(0, 8)}.beef`);

    setDownloadingBeef(false);
    if (!result.ok) {
      setError(result.error || 'Could not download proof');
    }
  }

  async function handleWalletConnect() {
    try {
      setError(null);
      await connect();
      setStep('amount');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleAmountNext() {
    if (tokens <= 0) {
      setError('Enter an amount greater than 0');
      return;
    }
    if (tokens > s.remaining) {
      setError(`Only ${s.remaining.toLocaleString('en-US')} tokens remaining`);
      return;
    }
    setError(null);
    setStep('confirm');
  }

  async function handleConfirmPurchase() {
    setStep('processing');
    setError(null);

    try {
      // Step 1: Reserve order
      setProcessingStatus('Reserving tokens...');
      const { PublicKey, P2PKH } = await import('@bsv/sdk');
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();

      const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
      const { publicKey: ownerPub } = await wallet.getPublicKey({
        protocolID: STAS_PROTOCOL,
        keyID: s.slug,
        counterparty: 'self',
      });
      const receiveAddress = PublicKey.fromString(ownerPub).toAddress().toString();

      const reserved = await reserveOrder({
        projectId: s.projectId,
        buyerIdentity: identityKey,
        receiveAddress,
        tokens,
      });
      if (!reserved.ok || !reserved.orderId) throw new Error(reserved.error ?? 'could not reserve tokens');

      // Step 2: Create payment
      setProcessingStatus('Creating payment transaction...');
      let txid: string | undefined;
      if (cost > 0) {
        if (!s.payoutAddress) throw new Error('this sale has no payout address configured yet');
        const lockingScript = new P2PKH().lock(s.payoutAddress).toHex();
        const res = (await wallet.createAction({
          description: `Buy ${tokens} ${s.ticker}`.slice(0, 50),
          outputs: [{ lockingScript, satoshis: cost, outputDescription: `pay ${s.ticker} sale`.slice(0, 50) }],
          options: { acceptDelayedBroadcast: false },
        })) as { txid?: string };
        txid = res?.txid;
        if (!txid) throw new Error('payment was not completed in the wallet');
      }
      setPaymentTxid(txid || null);

      // Step 3: Confirm payment
      setProcessingStatus('Confirming payment...');
      const r = await confirmOrderPayment(reserved.orderId, cost, txid);
      if (!r.ok) throw new Error(r.error ?? 'order failed');

      setProcessingStatus('Complete!');
      setStep('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('confirm'); // Go back to confirm step on error
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-xl border border-line bg-surface shadow-[var(--shadow-3)]">
        {/* Close button */}
        <button
          type="button"
          onClick={handleClose}
          className="absolute right-4 top-4 text-muted transition hover:text-fg"
          aria-label="Close"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Modal content */}
        <div className="p-6">
          {/* Step indicator */}
          <div className="mb-6 flex items-center gap-2">
            {(['connect', 'amount', 'confirm', 'processing', 'success'] as const).map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && <div className="h-px w-4 bg-line" />}
                <div
                  className={`h-2 w-2 rounded-full transition ${
                    step === s ? 'bg-gold' : i < ['connect', 'amount', 'confirm', 'processing', 'success'].indexOf(step) ? 'bg-teal' : 'bg-line'
                  }`}
                />
              </div>
            ))}
          </div>

          {/* Step: Wallet Connect */}
          {step === 'connect' && (
            <div>
              <h2 className="mb-2 text-xl font-semibold">Connect Wallet</h2>
              <p className="mb-6 text-sm text-muted">
                Connect your BSV Desktop wallet to continue. Your keys never leave your wallet—this is non-custodial.
              </p>
              <Button variant="primary" block onClick={handleWalletConnect}>
                Connect Wallet
              </Button>
            </div>
          )}

          {/* Step: Amount Input */}
          {step === 'amount' && (
            <div>
              <h2 className="mb-2 text-xl font-semibold">How many tokens?</h2>
              <p className="mb-4 text-sm text-muted">
                Enter the number of {s.ticker} tokens you want to buy. Price is fixed—no slippage.
              </p>

              <div className="mb-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <label className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Amount ({s.ticker})</label>
                  <button
                    type="button"
                    onClick={() => setAmount(s.remaining)}
                    className="font-mono text-xs text-teal underline underline-offset-2 hover:opacity-80"
                  >
                    {s.remaining.toLocaleString('en-US')} left · max
                  </button>
                </div>
                <NumberField value={amount} onValueChange={setAmount} min={1} max={s.remaining} />
              </div>

              <div className="mb-6 rounded-lg border border-line bg-elevated/40 p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Price per token</span>
                  <span className="font-mono tabular-nums text-fg">{s.priceSats} sats</span>
                </div>
                <div className="mt-2 flex justify-between text-base font-semibold">
                  <span>Total cost</span>
                  <span className="font-mono tabular-nums text-gold">{cost.toLocaleString('en-US')} sats</span>
                </div>
              </div>

              <Button variant="primary" block onClick={handleAmountNext}>
                Continue
              </Button>
            </div>
          )}

          {/* Step: Confirm */}
          {step === 'confirm' && (
            <div>
              <h2 className="mb-2 text-xl font-semibold">Confirm Purchase</h2>
              <p className="mb-4 text-sm text-muted">
                Review your purchase details. Price is locked—no front-running, no slippage.
              </p>

              <div className="mb-6 space-y-3 rounded-lg border border-line bg-elevated/40 p-4">
                <div className="flex justify-between">
                  <span className="text-sm text-muted">You pay</span>
                  <span className="font-mono text-base font-semibold tabular-nums text-fg">
                    {cost.toLocaleString('en-US')} sats
                  </span>
                </div>
                <div className="flex justify-center">
                  <svg className="h-5 w-5 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted">You get</span>
                  <span className="font-mono text-base font-semibold tabular-nums text-gold">
                    {tokens.toLocaleString('en-US')} {s.ticker}
                  </span>
                </div>
                <div className="border-t border-line pt-3">
                  <div className="flex justify-between text-xs">
                    <span className="text-faint">Price</span>
                    <span className="font-mono tabular-nums text-muted">{s.priceSats} sats/token</span>
                  </div>
                  <div className="mt-1 flex justify-between text-xs">
                    <span className="text-faint">Network</span>
                    <span className="font-mono text-muted">BSV Mainnet</span>
                  </div>
                  <div className="mt-1 flex justify-between text-xs">
                    <span className="text-faint">Finality</span>
                    <span className="font-mono text-teal">Instant</span>
                  </div>
                </div>
              </div>

              <div className="mb-4 flex gap-3">
                <Button variant="secondary" block onClick={() => setStep('amount')}>
                  Back
                </Button>
                <Button variant="primary" block onClick={handleConfirmPurchase}>
                  Confirm Purchase
                </Button>
              </div>
            </div>
          )}

          {/* Step: Processing */}
          {step === 'processing' && (
            <div className="text-center">
              <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-gold/10">
                <svg className="h-8 w-8 animate-spin text-gold" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              </div>
              <h2 className="mb-2 text-xl font-semibold">Processing...</h2>
              <p className="text-sm text-muted">{processingStatus}</p>
            </div>
          )}

          {/* Step: Success */}
          {step === 'success' && (
            <div className="text-center">
              <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-teal/10">
                <svg className="h-8 w-8 text-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="mb-2 text-xl font-semibold">Purchase Complete!</h2>
              <p className="mb-6 text-sm text-muted">
                Your order is placed and pending settlement. Tokens will be delivered to your wallet once the operator processes the queue.
              </p>

              <div className="mb-6 space-y-2 rounded-lg border border-line bg-elevated/40 p-4 text-left text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">Tokens</span>
                  <span className="font-mono tabular-nums text-fg">
                    {tokens.toLocaleString('en-US')} {s.ticker}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Paid</span>
                  <span className="font-mono tabular-nums text-fg">{cost.toLocaleString('en-US')} sats</span>
                </div>
                {paymentTxid && (
                  <div className="border-t border-line pt-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-faint">Payment TX</span>
                      <a
                        href={`https://whatsonchain.com/tx/${paymentTxid}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-teal underline underline-offset-2 hover:opacity-80"
                      >
                        {paymentTxid.slice(0, 8)}...{paymentTxid.slice(-8)} ↗
                      </a>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {paymentTxid && (
                  <Button variant="secondary" block onClick={handleDownloadProof} disabled={downloadingBeef}>
                    {downloadingBeef ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                        Downloading proof...
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Download SPV Proof (.beef)
                      </span>
                    )}
                  </Button>
                )}
                <Button variant="primary" block onClick={handleClose}>
                  Done
                </Button>
                <a
                  href="/portfolio"
                  className="block w-full text-center font-mono text-xs text-muted underline underline-offset-2 hover:text-fg"
                >
                  View Portfolio →
                </a>
              </div>
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
