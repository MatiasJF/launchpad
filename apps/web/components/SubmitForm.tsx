'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from './ui';
import { createProject } from '../lib/actions';
import { useWallet } from './WalletProvider';
import { Markdown } from './Markdown';

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
 * Project submission form. Uses the app-wide wallet connection — if already
 * connected (e.g. via the header) it shows the form immediately, no extra click.
 * The connected identity becomes the project OWNER; a payout address is derived
 * from the same wallet (editable). Non-custodial: we only read public keys.
 */
export function SubmitForm() {
  const { identityKey, status, connect } = useWallet();
  const [payoutAddress, setPayoutAddress] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [about, setAbout] = useState('');
  const [fileErr, setFileErr] = useState<string | null>(null);

  const onImageFile = (set: (v: string) => void, maxKB: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|ico|jpe?g|webp|svg)$/i.test(file.name)) {
      setFileErr('use a PNG, ICO, JPG or WEBP image');
      return;
    }
    if (file.size > maxKB * 1024) {
      setFileErr(`image too large (max ${maxKB}KB)`);
      return;
    }
    setFileErr(null);
    const reader = new FileReader();
    reader.onload = () => set(String(reader.result));
    reader.readAsDataURL(file);
  };

  // Derive a payout address once connected (best-effort; editable; never blocks).
  useEffect(() => {
    if (!identityKey || payoutAddress) return;
    let live = true;
    (async () => {
      try {
        const { getWalletClient } = await import('@launchpad/bsv/wallet');
        const { PublicKey } = await import('@bsv/sdk');
        const wallet = await getWalletClient();
        try {
          const { publicKey } = await wallet.getPublicKey({ protocolID: PAYOUT_PROTOCOL, keyID: 'payout', counterparty: 'self' });
          if (live) setPayoutAddress(PublicKey.fromString(publicKey).toAddress().toString());
        } catch {
          if (live) setPayoutAddress(PublicKey.fromString(identityKey).toAddress().toString());
        }
      } catch {
        /* leave blank — user pastes */
      }
    })();
    return () => {
      live = false;
    };
  }, [identityKey, payoutAddress]);

  if (!identityKey) {
    return (
      <div className="mt-6 rounded-lg border border-line bg-surface p-5">
        <p className="text-sm text-muted">
          Connect your wallet to submit. Your wallet identity becomes the project owner — only you will be able to
          issue and settle this token.
        </p>
        <div className="mt-4">
          <Button variant="primary" onClick={connect} disabled={status === 'connecting'}>
            {status === 'connecting' ? 'Connecting…' : 'Connect wallet to submit'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={createProject} className="mt-6 flex flex-col gap-4">
      <input type="hidden" name="identityPubkey" value={identityKey} />
      <div className="rounded-md border border-teal/40 bg-teal/10 px-4 py-2.5 font-mono text-xs text-teal">
        owner {identityKey.slice(0, 20)}…
      </div>

      <Field name="name" label="Project name" required />
      <Field name="ticker" label="Ticker (e.g. $ABC)" required />
      <Field name="blurb" label="Short description (one line)" />

      {/* Logo + banner (upload or URL) */}
      <input type="hidden" name="logoUrl" value={logoUrl} />
      <input type="hidden" name="banner" value={bannerUrl} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className={labelCls}>Logo — upload PNG/ICO or paste https URL</span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn btn-secondary cursor-pointer">
              Upload
              <input type="file" accept="image/*,.ico" onChange={onImageFile(setLogoUrl, 200)} className="hidden" />
            </label>
            {logoUrl.startsWith('data:') && <span className="font-mono text-xs text-teal">✓ loaded</span>}
          </div>
          <input
            value={logoUrl.startsWith('data:') ? '' : logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…/logo.png"
            className={`${inputCls} font-mono text-sm`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={labelCls}>Banner — upload or paste https URL (wide)</span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn btn-secondary cursor-pointer">
              Upload
              <input type="file" accept="image/*" onChange={onImageFile(setBannerUrl, 1000)} className="hidden" />
            </label>
            {bannerUrl.startsWith('data:') && <span className="font-mono text-xs text-teal">✓ loaded</span>}
          </div>
          <input
            value={bannerUrl.startsWith('data:') ? '' : bannerUrl}
            onChange={(e) => setBannerUrl(e.target.value)}
            placeholder="https://…/banner.jpg"
            className={`${inputCls} font-mono text-sm`}
          />
        </div>
      </div>
      {fileErr && <p className="text-xs text-danger">⚠ {fileErr}</p>}
      <Field name="website" label="Website (https)" type="url" />

      <label className="flex flex-col gap-1.5">
        <span className={labelCls}>
          About — Markdown supported (**bold**, # heading, [link](https://…), ![img](https://…))
        </span>
        <textarea
          name="about"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          rows={6}
          className={`${inputCls} font-mono`}
        />
      </label>
      {about.trim() && (
        <div className="rounded-md border border-line bg-elevated/40 p-3">
          <span className="mb-2 block font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">Preview</span>
          <Markdown>{about}</Markdown>
        </div>
      )}
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
