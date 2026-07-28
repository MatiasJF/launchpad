'use client';

import { useState, type ChangeEvent } from 'react';
import { Button } from './ui';
import { IssueButton } from './IssueButton';
import { SettleOrderButton } from './SettleOrderButton';
import { useWallet } from './WalletProvider';
import { updateProjectMeta, updateSaleSchedule, deleteProject } from '../lib/actions';
import { Markdown } from './Markdown';

export type ManageVM = {
  projectId: string;
  slug: string;
  name: string;
  status: string;
  payoutAddress: string | null;
  ownerIdentity: string;
  description: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  website: string | null;
  sale: { status: string; startsAt: string | null; endsAt: string | null } | null;
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
/** ISO (UTC) → a `datetime-local` value in the viewer's LOCAL time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ProjectManage({ p }: { p: ManageVM }) {
  const { identityKey: identity, status, error, connect } = useWallet();
  const [meta, setMeta] = useState({
    logoUrl: p.logoUrl ?? '',
    bannerUrl: p.bannerUrl ?? '',
    website: p.website ?? '',
    description: p.description ?? '',
  });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [sched, setSched] = useState({
    status: p.sale?.status ?? 'scheduled',
    startsAt: toLocalInput(p.sale?.startsAt ?? null),
    endsAt: toLocalInput(p.sale?.endsAt ?? null),
  });

  // Live "will this be buyable?" readout from the current editor settings.
  const effState = (() => {
    if (sched.status !== 'live') {
      return sched.status === 'finalized'
        ? { open: false, label: 'Ended — status is Finalized' }
        : { open: false, label: 'Upcoming — status is Scheduled' };
    }
    const now = Date.now();
    const st = sched.startsAt ? new Date(sched.startsAt).getTime() : null;
    const en = sched.endsAt ? new Date(sched.endsAt).getTime() : null;
    if (st && st > now) return { open: false, label: 'Upcoming — start time is in the future' };
    if (en && en <= now) return { open: false, label: 'Ended — end time is in the past' };
    return { open: true, label: 'Open — buyable now' };
  })();
  const [schedState, setSchedState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [schedErr, setSchedErr] = useState<string | null>(null);

  // Read an uploaded image into a data URI for a given meta field.
  const onImageFile = (field: 'logoUrl' | 'bannerUrl', maxKB: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|ico|jpe?g|webp|svg)$/i.test(file.name)) {
      setSaveState('error');
      setSaveErr('use a PNG, ICO, JPG or WEBP image');
      return;
    }
    if (file.size > maxKB * 1024) {
      setSaveState('error');
      setSaveErr(`image too large (max ${maxKB}KB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setMeta((m) => ({ ...m, [field]: String(reader.result) }));
      setSaveState('idle');
      setSaveErr(null);
    };
    reader.readAsDataURL(file);
  };

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

  const [tab, setTab] = useState<'details' | 'schedule' | 'issuance' | 'orders' | 'danger'>('details');
  const [deleting, setDeleting] = useState(false);
  async function doDelete() {
    if (!identity) return;
    const ok = window.confirm(
      `Delete “${p.name}”? This removes the project, token, sale and all orders from the launchpad. ` +
        `Tokens already issued on-chain are NOT affected. This cannot be undone.`,
    );
    if (!ok) return;
    setDeleting(true);
    const res = await deleteProject(p.projectId, identity);
    if (res.ok) window.location.href = '/';
    else {
      setDeleting(false);
      window.alert(`Delete failed: ${res.error ?? 'unknown error'}`);
    }
  }

  async function saveSched() {
    if (!identity) return;
    setSchedState('saving');
    setSchedErr(null);
    const res = await updateSaleSchedule({
      projectId: p.projectId,
      identityPubkey: identity,
      status: sched.status,
      startsAt: sched.startsAt,
      endsAt: sched.endsAt,
    });
    if (res.ok) setSchedState('saved');
    else {
      setSchedState('error');
      setSchedErr(res.error ?? 'update failed');
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
        <div className="mt-8">
          <div className="flex gap-1 overflow-x-auto border-b border-line">
            {(
              [
                ['details', 'Details'],
                ['schedule', 'Schedule'],
                ['issuance', 'Issuance'],
                ['orders', `Orders${pending.length ? ` (${pending.length})` : ''}`],
                ['danger', 'Danger'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                  tab === id ? 'border-gold text-fg' : 'border-transparent text-muted hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-6 flex flex-col gap-8" hidden={tab !== 'details'}>
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
                    <input type="file" accept="image/png,image/x-icon,.ico,.png,image/*" onChange={onImageFile('logoUrl', 200)} className="hidden" />
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

              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">
                  Banner / cover image — upload a file, or paste a DIRECT image link (…/photo.jpg — not a page link)
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="btn btn-secondary cursor-pointer">
                    Upload banner
                    <input type="file" accept="image/*" onChange={onImageFile('bannerUrl', 1000)} className="hidden" />
                  </label>
                  {meta.bannerUrl?.startsWith('data:') && <span className="font-mono text-xs text-teal">✓ image loaded</span>}
                </div>
                <input
                  value={meta.bannerUrl?.startsWith('data:') ? '' : meta.bannerUrl}
                  onChange={(e) => setMeta((m) => ({ ...m, bannerUrl: e.target.value }))}
                  placeholder="…or https://…/banner.jpg"
                  className={`${metaInput} font-mono`}
                />
                {meta.bannerUrl && (
                  <img src={meta.bannerUrl} alt="banner preview" className="h-24 w-full rounded-md border border-line object-cover" />
                )}
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
                <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">
                  Description — Markdown supported (**bold**, # heading, [link](https://…), ![img](https://…))
                </span>
                <textarea
                  value={meta.description}
                  onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
                  rows={6}
                  className={`${metaInput} font-mono`}
                />
              </label>
              {meta.description.trim() && (
                <div className="rounded-md border border-line bg-elevated/40 p-3">
                  <span className="mb-2 block font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">Preview</span>
                  <Markdown>{meta.description}</Markdown>
                </div>
              )}
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
          </div>

          <div hidden={tab !== 'schedule'}>
          {/* Sale schedule */}
          <section>
            <h2 className="text-xl font-semibold">Sale schedule</h2>
            <p className="mt-1 text-sm text-muted">
              Buyers can only buy while <strong>Live</strong> and within the start/end window. To reopen a closed
              sale: set <strong>Live</strong> and either clear the end time or set it to the future. Times are your
              local time.
            </p>
            <div
              className={`mt-3 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs ${
                effState.open ? 'border-teal/40 bg-teal/10 text-teal' : 'border-warning/40 bg-warning/10 text-warning'
              }`}
            >
              {effState.open ? '● ' : '○ '}
              {effState.label}
            </div>
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {(['scheduled', 'live', 'finalized'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setSched((s) => ({ ...s, status: st }))}
                    className="chip capitalize"
                    data-active={sched.status === st}
                  >
                    {st}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Starts at</span>
                  <input
                    type="datetime-local"
                    value={sched.startsAt}
                    onChange={(e) => setSched((s) => ({ ...s, startsAt: e.target.value }))}
                    className={metaInput}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Ends at</span>
                  <input
                    type="datetime-local"
                    value={sched.endsAt}
                    onChange={(e) => setSched((s) => ({ ...s, endsAt: e.target.value }))}
                    className={metaInput}
                  />
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Button variant="primary" onClick={saveSched} disabled={schedState === 'saving'}>
                  {schedState === 'saving' ? 'Saving…' : 'Save schedule'}
                </Button>
                {schedState === 'saved' && <span className="font-mono text-xs text-teal">✓ saved</span>}
                {schedState === 'error' && <span className="font-mono text-xs text-danger">⚠ {schedErr}</span>}
              </div>
            </div>
          </section>
          </div>

          <div hidden={tab !== 'issuance'}>
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
          </div>

          <div hidden={tab !== 'orders'}>
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

          <div hidden={tab !== 'danger'}>
          {/* Danger zone */}
          <section className="rounded-lg border border-danger/40 bg-danger/5 p-4">
            <h2 className="text-xl font-semibold text-danger">Delete project</h2>
            <p className="mt-1 text-sm text-muted">
              Removes the project, token, sale and all orders from the launchpad. Tokens already issued on-chain are
              not affected. This cannot be undone.
            </p>
            <button
              type="button"
              onClick={doDelete}
              disabled={deleting}
              className="btn mt-3 border-danger/50 bg-danger/15 text-danger hover:bg-danger/25"
            >
              {deleting ? 'Deleting…' : 'Delete this project'}
            </button>
          </section>
          </div>
        </div>
      )}
    </div>
  );
}
