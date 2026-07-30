'use client';

import { useState, type ChangeEvent } from 'react';
import { Button, NumberField } from './ui';
import { IssueButton } from './IssueButton';
import { SettleOrderButton } from './SettleOrderButton';
import { useWallet } from './WalletProvider';
import { updateProjectMeta, updateSaleSchedule, deleteProject, updateSaleEscrow } from '../lib/actions';
import { getPledgesForAssembly, markAssemblyBroadcast } from '../lib/escrow-actions';
import { getBatchForSale, markOrdersSettled } from '../lib/order-actions';
import { broadcastRawTx, resolveCurrentPool, getOutputInfo, getSourceBeef } from '../lib/settle-actions';
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
  sale: {
    id: string;
    status: string;
    startsAt: string | null;
    endsAt: string | null;
    type: string;
    softCapSats: number;
    hardCapSats: number;
    pledgeUnitSats: number;
    raisedSats: number;
    assured: boolean;
  } | null;
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

  const [tab, setTab] = useState<'details' | 'schedule' | 'presale' | 'issuance' | 'orders' | 'danger'>('details');

  const [esc, setEsc] = useState({
    type: p.sale?.type ?? 'instant',
    softCapSats: p.sale?.softCapSats ?? 0,
    hardCapSats: p.sale?.hardCapSats ?? 0,
    pledgeUnitSats: p.sale?.pledgeUnitSats ?? 0,
  });
  const [escState, setEscState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [escErr, setEscErr] = useState<string | null>(null);
  async function saveEscrow() {
    if (!identity) return;
    setEscState('saving');
    setEscErr(null);
    const res = await updateSaleEscrow({
      projectId: p.projectId,
      identityPubkey: identity,
      type: esc.type as 'instant' | 'escrow_presale',
      softCapSats: esc.softCapSats,
      hardCapSats: esc.hardCapSats,
      pledgeUnitSats: esc.pledgeUnitSats,
    });
    if (res.ok) setEscState('saved');
    else {
      setEscState('error');
      setEscErr(res.error ?? 'update failed');
    }
  }

  const [asm, setAsm] = useState<'idle' | 'working' | 'done'>('idle');
  const [asmMsg, setAsmMsg] = useState('');
  const [asmTxid, setAsmTxid] = useState('');
  async function assemble() {
    if (!identity || !p.sale) return;
    setAsm('working');
    setAsmMsg('gathering + re-validating pledges');
    try {
      const g = await getPledgesForAssembly(p.sale.id, identity);
      if (!g.ok) throw new Error(g.error);
      setAsmMsg('assembling assurance tx (approve fee in wallet)');
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { assembleAssuranceTx } = await import('@launchpad/bsv/pledge');
      const wallet = await getWalletClient();
      const res = await assembleAssuranceTx(wallet as never, 'main', {
        pledges: g.pledges,
        softCapSats: g.softCapSats,
        projectAddress: g.projectAddress,
      });
      if (!res.ok) throw new Error(res.reason);
      setAsmMsg('broadcasting fee funding');
      const bc1 = await broadcastRawTx(res.feeFundingRawTx, '');
      if (!bc1.ok) throw new Error(`fee funding broadcast: ${bc1.error}`);
      setAsmMsg('broadcasting assurance tx');
      const bc2 = await broadcastRawTx(res.assuranceRawTx, res.assuranceTxid);
      if (!bc2.ok) throw new Error(`assurance broadcast: ${bc2.error}`);
      const txid = bc2.txid || res.assuranceTxid;
      await markAssemblyBroadcast(p.sale.id, identity, txid, g.pledges.map((x) => x.id));
      setAsmTxid(txid);
      setAsm('done');
    } catch (e) {
      setAsmMsg(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      setAsm('idle');
    }
  }
  const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];
  const [batchState, setBatchState] = useState<'idle' | 'working' | 'done'>('idle');
  const [batchMsg, setBatchMsg] = useState('');
  const [batchTxid, setBatchTxid] = useState('');
  async function batchSettle() {
    if (!p.sale) return;
    setBatchState('working');
    setBatchMsg('gathering orders');
    try {
      const b = await getBatchForSale(p.sale.id);
      if (!b.ok) throw new Error(b.error);
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { batchTransferStas, MAX_BATCH_RECIPIENTS } = await import('@launchpad/bsv/settle');
      const wallet = await getWalletClient();

      // Resolve the starting pool.
      setBatchMsg('resolving current pool');
      const pool0 = await resolveCurrentPool(b.mintTxid);
      if ('error' in pool0) throw new Error(pool0.error);
      const info0 = await getOutputInfo(pool0.txid, pool0.vout);
      if (!info0) throw new Error('could not fetch the pool UTXO');
      const total = b.recipients.reduce((s, r) => s + r.amount, 0);
      if (total > info0.satoshis) throw new Error(`pool holds ${info0.satoshis} tokens; batch needs ${total}`);
      const beef0 = await getSourceBeef(pool0.txid);
      if (!beef0) throw new Error('pool must be confirmed to settle');

      // Chunk into groups of ≤3 (STAS 5-output limit) and CHAIN them: each chunk
      // spends the previous chunk's token-change, using its BEEF — no waiting.
      let cur = { txid: pool0.txid, vout: pool0.vout, scriptHex: info0.scriptHex, satoshis: info0.satoshis, beef: beef0 as number[] };
      const chunks: (typeof b.recipients)[] = [];
      for (let i = 0; i < b.recipients.length; i += MAX_BATCH_RECIPIENTS) chunks.push(b.recipients.slice(i, i + MAX_BATCH_RECIPIENTS));
      let lastTxid = '';
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c] as typeof b.recipients;
        setBatchMsg(`chunk ${c + 1}/${chunks.length} · building (approve in wallet)`);
        const res = await batchTransferStas(wallet as never, '', 'main', {
          source: {
            txid: cur.txid,
            vout: cur.vout,
            scriptHex: cur.scriptHex,
            satoshis: cur.satoshis,
            beef: cur.beef,
            brc42KeyId: `${b.slug}-owner`,
            owner: { protocolID: STAS_PROTOCOL, keyID: `${b.slug}-owner`, counterparty: 'self', forSelf: false },
          },
          recipients: chunk.map((r) => ({ address: r.address, amount: r.amount })),
          senderChangeHash160: cur.scriptHex.substring(6, 46),
        });
        if (!res.ok) throw new Error(res.reason);
        setBatchMsg(`chunk ${c + 1}/${chunks.length} · broadcasting funding`);
        const bc1 = await broadcastRawTx(res.fundingRawTx, res.fundingTxid);
        if (!bc1.ok) throw new Error(`funding broadcast: ${bc1.error}`);
        setBatchMsg(`chunk ${c + 1}/${chunks.length} · broadcasting transfer`);
        const bc2 = await broadcastRawTx(res.rawTx, res.txid);
        if (!bc2.ok) throw new Error(`transfer broadcast: ${bc2.error}`);
        lastTxid = bc2.txid || res.txid;
        // Record this chunk's orders as delivered by this chunk's tx.
        await markOrdersSettled(chunk.map((r) => r.orderId), lastTxid);
        // Chain the next chunk onto this tx's token-change.
        if (res.newPool && c < chunks.length - 1) {
          cur = { ...res.newPool, beef: res.chainBeef };
        }
      }
      setBatchTxid(lastTxid);
      setBatchState('done');
    } catch (e) {
      setBatchMsg(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      setBatchState('idle');
    }
  }

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
                ['presale', 'Presale'],
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

          <div hidden={tab !== 'presale'}>
          <section>
            <h2 className="text-xl font-semibold">Escrow presale</h2>
            <p className="mt-1 text-sm text-muted">
              Trustless soft-cap sale (ADR-025). Contributors pledge a fixed unit; funds stay in their wallets until
              the soft cap is met, then you assemble the assurance tx. Caps must be whole multiples of the pledge unit.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {(['instant', 'escrow_presale'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setEsc((s) => ({ ...s, type: t }))} className="chip" data-active={esc.type === t}>
                    {t === 'instant' ? 'Instant buy' : 'Escrow presale'}
                  </button>
                ))}
              </div>
              {esc.type === 'escrow_presale' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Pledge unit (sats)</span>
                    <NumberField value={esc.pledgeUnitSats} onValueChange={(n) => setEsc((s) => ({ ...s, pledgeUnitSats: n }))} min={0} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Soft cap (sats)</span>
                    <NumberField value={esc.softCapSats} onValueChange={(n) => setEsc((s) => ({ ...s, softCapSats: n }))} min={0} />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="font-mono text-xs uppercase tracking-[0.08em] text-faint">Hard cap (sats)</span>
                    <NumberField value={esc.hardCapSats} onValueChange={(n) => setEsc((s) => ({ ...s, hardCapSats: n }))} min={0} />
                  </label>
                </div>
              )}
              <div className="flex items-center gap-3">
                <Button variant="primary" onClick={saveEscrow} disabled={escState === 'saving'}>
                  {escState === 'saving' ? 'Saving…' : 'Save presale terms'}
                </Button>
                {escState === 'saved' && <span className="font-mono text-xs text-teal">✓ saved</span>}
                {escState === 'error' && <span className="font-mono text-xs text-danger">⚠ {escErr}</span>}
              </div>
            </div>

            {p.sale?.type === 'escrow_presale' && (
              <div className="mt-6 rounded-md border border-line bg-elevated/40 p-4">
                <p className="font-mono text-xs text-muted">
                  Raised {p.sale.raisedSats.toLocaleString('en-US')} / {p.sale.softCapSats.toLocaleString('en-US')} soft
                  cap sats
                </p>
                {p.sale.assured || (asm === 'done' && asmTxid) ? (
                  <p className="mt-2 font-mono text-xs text-teal">
                    ✓ Soft cap funded — the sale is now open for instant top-up buys up to the hard cap.
                    {asmTxid && (
                      <>
                        {' '}
                        <a href={`https://whatsonchain.com/tx/${asmTxid}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                          {asmTxid.slice(0, 12)}… ↗
                        </a>
                      </>
                    )}
                  </p>
                ) : p.sale.raisedSats >= p.sale.softCapSats && p.sale.softCapSats > 0 ? (
                  <div className="mt-3">
                    <Button variant="primary" onClick={assemble} disabled={asm === 'working'}>
                      {asm === 'working' ? 'Assembling…' : 'Assemble & broadcast assurance tx'}
                    </Button>
                    {asmMsg && <p className="mt-2 break-words font-mono text-xs text-muted">{asmMsg}</p>}
                  </div>
                ) : (
                  <p className="mt-2 font-mono text-xs text-faint">Soft cap not reached yet — nothing to assemble.</p>
                )}
              </div>
            )}
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
            {p.token?.issuanceTxid && pending.length > 1 && (
              <div className="mt-3 rounded-md border border-violet/40 bg-[color-mix(in_srgb,var(--c-violet)_7%,transparent)] p-3">
                <p className="mb-2 text-sm text-muted">
                  Deliver every pending order — chained in groups of {3} (STAS allows ≤ 3 recipients per tx). After it
                  finishes, give the chain a minute to confirm before other on-chain actions.
                </p>
                {batchState === 'done' && batchTxid ? (
                  <a
                    href={`https://whatsonchain.com/tx/${batchTxid}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-teal underline underline-offset-2"
                  >
                    ✓ all settled · {batchTxid.slice(0, 12)}… ↗
                  </a>
                ) : (
                  <>
                    <Button variant="primary" onClick={batchSettle} disabled={batchState === 'working'}>
                      {batchState === 'working' ? 'Settling…' : `Settle all ${pending.length} in one tx`}
                    </Button>
                    {batchMsg && <p className="mt-2 break-words font-mono text-xs text-muted">{batchMsg}</p>}
                  </>
                )}
              </div>
            )}
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
