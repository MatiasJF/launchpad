'use client';

import { useState } from 'react';
import { Button } from './ui';
import { createProject } from '../lib/actions';

const ORIGINATOR = 'launchpad.local';
const PAYOUT_PROTOCOL: [1, string] = [1, 'launchpad-payout'];

const inputCls = 'rounded-md border border-line bg-elevated px-3 py-2.5 text-fg outline-none transition focus:border-gold';
const labelCls = 'font-mono text-xs uppercase tracking-[0.08em] text-faint';

function Field({ name, label, type = 'text', required }: { name: string; label: string; type?: string; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls}>
        {label}
        {required ? ' *' : ''}
      </span>
      <input name={name} type={type} required={required} min={type === 'number' ? 0 : undefined} className={inputCls} />
    </label>
  );
}

/**
 * Project submission form. Connects the submitter's BRC-100 wallet first — their
 * identity becomes the project OWNER (only they can later issue/settle it), and a
 * payout address is derived from their wallet (editable) so sale proceeds go to
 * them, not the platform. Non-custodial: we only read public keys.
 */
export function SubmitForm() {
  const [identityPubkey, setIdentityPubkey] = useState('');
  const [payoutAddress, setPayoutAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      const { WalletClient, PublicKey } = await import('@bsv/sdk');
      const wallet = new WalletClient('auto', ORIGINATOR);
      await wallet.waitForAuthentication({});
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      setIdentityPubkey(identity);
      // Best-effort payout autofill from a dedicated wallet key (seller controls
      // it). If derivation isn't supported by the wallet, fall back to the
      // identity-key address, then leave it for manual paste — never block the
      // form on this (the field stays editable regardless).
      try {
        const { publicKey: payoutPub } = await wallet.getPublicKey({
          protocolID: PAYOUT_PROTOCOL,
          keyID: 'payout',
          counterparty: 'self',
        });
        setPayoutAddress(PublicKey.fromString(payoutPub).toAddress().toString());
      } catch {
        try {
          setPayoutAddress(PublicKey.fromString(identity).toAddress().toString());
        } catch {
          /* leave blank — user pastes a payout address */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  if (!identityPubkey) {
    return (
      <div className="mt-6 rounded-lg border border-line bg-surface p-5">
        <p className="text-sm text-muted">
          Connect your wallet to submit. Your wallet identity becomes the project owner — only you will be able to
          issue and settle this token.
        </p>
        {error && <p className="mt-3 break-words text-xs text-danger">⚠ {error}</p>}
        <div className="mt-4">
          <Button variant="primary" onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect wallet to submit'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={createProject} className="mt-6 flex flex-col gap-4">
      <input type="hidden" name="identityPubkey" value={identityPubkey} />
      <div className="rounded-md border border-teal/40 bg-teal/10 px-4 py-2.5 font-mono text-xs text-teal">
        owner {identityPubkey.slice(0, 20)}…
      </div>

      <Field name="name" label="Project name" required />
      <Field name="ticker" label="Ticker (e.g. $ABC)" required />
      <Field name="blurb" label="Short description" />
      <label className="flex flex-col gap-1.5">
        <span className={labelCls}>About</span>
        <textarea name="about" rows={3} className={inputCls} />
      </label>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field name="totalSupply" label="Total supply" type="number" />
        <Field name="publicAllocation" label="Public allocation" type="number" />
        <Field name="priceSats" label="Price (sats)" type="number" />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className={labelCls}>Payout address * — sale proceeds go here (your wallet)</span>
        <input
          name="payoutAddress"
          value={payoutAddress}
          onChange={(e) => setPayoutAddress(e.target.value)}
          required
          className={`${inputCls} font-mono text-sm`}
        />
      </label>

      <div className="mt-2">
        <Button variant="primary" type="submit">
          Submit for review
        </Button>
      </div>
    </form>
  );
}
