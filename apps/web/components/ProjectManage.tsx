'use client';

import { useState, type ChangeEvent } from 'react';
import { Button } from './ui';
import { IssueButton } from './IssueButton';
import { SettleOrderButton } from './SettleOrderButton';
import { useWallet } from './WalletProvider';
import { updateProjectMeta } from '../lib/actions';

export type ManageVM = {
  projectId: string;
  slug: string;
  name: string;
  status: string;
  payoutAddress: string | null;
  ownerIdentity: string;
  description: string | null;
  logoUrl: string | null;
  website: string | null;
  token: { ticker: string; supply: number; issuanceTxid: string | null; tokenId: string | null } | null;
  orders: {
    id: string;
    tokens: number;
    receiveAddress: string | null;
    state: string;
    txid: string | null;
    satsPaid: number;
    buyerIdentity: string;
  }[];
};

/**
 * Project owner's self-service dashboard. Gated by connecting the OWNER's wallet
 * (identity must match the project owner). From here the issuer — not the platform
 * admin — issues their own token and settles their own sales; their wallet signs
 * and pays. Non-custodial throughout.
 */
export function ProjectManage({ p }: { p: ManageVM }) {
  const { identityKey: identity, status, error, connect } = useWallet();
  const [meta, setMeta] = useState({ logoUrl: p.logoUrl ?? '', website: p.website ?? '', description: p.description ?? '' });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveErr, setSaveErr] = useState<string | null>(null);

  function onLogoFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|webp|svg\+xml)$/.test(file.type) && !/\.(png|ico)$/i.test(file.name)) {
      setSaveState('error');
      setSaveErr('use a PNG or ICO image');
      return;
    }
    if (file.size > 200 * 1024) {
      setSaveState('error');
      setSaveErr('image too large (max 200KB) — use a small square logo');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setMeta((m) => ({ ...m, logoUrl: String(reader.result) }));
      setSaveState('idle');
      setSaveErr(null);
    };
    reader.readAsDataURL(file);
  }

  async function saveMeta() {
    if (!identity) return;
    setSaveState('saving');
    setSaveErr(null);
    const res = await updateProjectMeta({ projectId: p.projectId, identityPubkey: identity, ...meta });
    if (res.ok) setSaveState('saved');
    else {
      setSaveState('error');
      setSaveErr(res.error ?? 'update failed');
    }
  }

  const isOwner = !!identity && identity === p.ownerIdentity;
  const metaInput = 'rounded-md border border-line bg-elevated px-3 py-2.5 text-sm text-fg outline-none transition focus:border-gold';
  const pending = p.orders.filter((o) => o.state === 'pending');
  const settled = p.orders.filter((o) => o.state === 'settled');

  return (
    <div className="reveal mx-auto max-w-[760px]">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[2rem] font-semibold">{p.name}</h1>
        {p.token && <span className="font-mono text-sm text-faint">{p.token.ticker}</span>}
        <span className="pill" style={{ ['--tone' as string]: 'var(--c-teal)' }}>
          {p.status}
        </span>
      </div>
      <p className="mt-1 font-mono text-xs text-faint">owner {p.ownerIdentity.slice(0, 24)}…</p>

      {!identity ? (
        <div className="mt-6 rounded-lg border border-line bg-surface p-5">
          <p className="text-sm text-muted">Connect the project owner wallet to manage issuance and settlement.</p>
          {error && <p className="mt-3 break-words text-xs text-danger">⚠ {error}</p>}
          <div className="mt-4">
            <Button variant="primary" onClick={connect} disabled={status === 'connecting'}>
              {status === 'connecting' ? 'Connecting…' : 'Connect owner wallet'}
            </Button>
          </div>
        </div>
      ) : !isOwner ? (
        <div className="mt-6 rounded-lg border border-danger/40 bg-danger/10 p-5 text-sm text-danger">
          This dashboard is for the project owner. The connected wallet ({identity.slice(0, 16)}…) is not the owner
          of this project.
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-10">
          {/* Payout */}
          <section>
            <h2 className="text-xl font-semibold">Payout address</h2>
            <p className="mt-2 break-all rounded-md border border-line bg-elevated p-3 font-mono text-sm text-fg">
              {p.payoutAddress ?? '— not set —'}
            </p>
            <p className="mt-1 text-xs text-muted">Buyers pay here; sale proceeds go straight to your wallet.</p>
          </section>

          {/* Editable display metadata */}
          <section>
            <h2 className="text-xl font-semibold">Project details</h2>
            <p className="mt-1 text-sm text-muted">
              Logo, website and description. Set these <strong>before issuing</strong> so they’re embedded in the
              token’s on-chain metadata too.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">
                  Logo — upload PNG/ICO, or paste an https URL
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="btn btn-secondary cursor-pointer">
                    Upload PNG/ICO
                    <input type="file" accept="image/png,image/x-icon,.ico,.png,image/*" onChange={onLogoFile} className="hidden" />
                  </label>
                  {meta.logoUrl?.startsWith('data:') && <span className="font-mono text-xs text-teal">✓ image loaded</span>}
                </div>
                <input
                  value={meta.logoUrl?.startsWith('data:') ? '' : meta.logoUrl}
                  onChange={(e) => setMeta((m) => ({ ...m, logoUrl: e.target.value }))}
                  placeholder="…or https://…/logo.png"
                  className={`${metaInput} font-mono`}
                />
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Website (https)</span>
                <input
                  value={meta.website}
                  onChange={(e) => setMeta((m) => ({ ...m, website: e.target.value }))}
                  placeholder="https://…"
                  className={`${metaInput} font-mono`}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Description</span>
                <textarea
                  value={meta.description}
                  onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
                  rows={3}
                  className={metaInput}
                />
              </label>
              <div className="flex items-center gap-3">
                <Button variant="primary" onClick={saveMeta} disabled={saveState === 'saving'}>
                  {saveState === 'saving' ? 'Saving…' : 'Save details'}
                </Button>
                {saveState === 'saved' && <span className="font-mono text-xs text-teal">✓ saved</span>}
                {saveState === 'error' && <span className="font-mono text-xs text-danger">⚠ {saveErr}</span>}
              </div>
              {meta.logoUrl && (
                <img
                  src={meta.logoUrl}
                  alt="logo preview"
                  className="h-14 w-14 rounded-xl border border-line object-cover"
                />
              )}
            </div>
          </section>

          {/* Issuance */}
          <section>
            <h2 className="text-xl font-semibold">Token issuance</h2>
            {!p.token ? (
              <p className="mt-2 text-muted">No token configured.</p>
            ) : p.token.issuanceTxid ? (
              <p className="mt-2 text-sm text-muted">
                Issued ·{' '}
                <a
                  href={`https://whatsonchain.com/tx/${p.token.issuanceTxid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-teal underline underline-offset-2"
                >
                  {p.token.issuanceTxid.slice(0, 12)}… ↗
                </a>
              </p>
            ) : p.status === 'live' || p.status === 'approved' ? (
              <div className="mt-3">
                <IssueButton
                  projectId={p.projectId}
                  ticker={p.token.ticker}
                  supply={p.token.supply}
                  slug={p.slug}
                  name={p.name}
                  description={p.description}
                  logoUrl={p.logoUrl}
                  website={p.website}
                />
              </div>
            ) : (
              <p className="mt-2 text-sm text-warning">Awaiting admin approval before you can issue.</p>
            )}
          </section>

          {/* Settlement */}
          <section>
            <h2 className="text-xl font-semibold">Orders to settle ({pending.length})</h2>
            {!p.token?.issuanceTxid ? (
              <p className="mt-2 text-sm text-muted">Issue the token first, then paid orders appear here.</p>
            ) : pending.length === 0 ? (
              <p className="mt-2 text-muted">No paid orders waiting.</p>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                {pending.map((o) => (
                  <div key={o.id} className="rounded-lg border border-line bg-surface p-4">
                    <p className="mb-3 font-mono text-xs text-faint">
                      {o.tokens.toLocaleString('en-US')} {p.token?.ticker} → {o.receiveAddress?.slice(0, 14)}… · buyer{' '}
                      {o.buyerIdentity.slice(0, 12)}… · {o.satsPaid.toLocaleString('en-US')} sats
                    </p>
                    {o.receiveAddress && p.token?.issuanceTxid && (
                      <SettleOrderButton
                        orderId={o.id}
                        slug={p.slug}
                        receiveAddress={o.receiveAddress}
                        tokens={o.tokens}
                        defaultTxid={p.token.issuanceTxid}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {settled.length > 0 && (
              <p className="mt-3 text-xs text-muted">{settled.length} settled · delivered on-chain.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
