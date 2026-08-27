'use client';

import { useEffect, useState } from 'react';
import { Button } from './ui';
import { useWallet } from './WalletProvider';
import { broadcastRawTx } from '../lib/settle-actions';
import { createStasPool, markStasPoolDeployed, prepareStasMint, recordStasMint, getStasPool } from '../lib/stas-actions';

// Canonical STAS BRC-42 protocol id (ADR-021). Hardcoded so the client never
// imports @launchpad/bsv statically (it pulls the heavy bsv/stas-js libs).
const STAS_PROTOCOL: [2, string] = [2, '3241645161d8'];

type Phase = 'loading' | 'deploy' | 'mint' | 'ready';

/**
 * Owner-only STAS bonding-curve control (ADR-028, Option B). Two signed steps,
 * mirroring CurvePoolDeploy (deploy) + IssueButton (mint):
 *   1. DEPLOY — the owner's wallet seeds the reserve covenant (createAction output
 *      of `seed` sats locked to the genesis reserve script). k + supply are
 *      configurable and default to a TINY demo pool so a mainnet round-trip is cheap.
 *   2. MINT — the owner's wallet runs the CONTRACT → ISSUE genesis for the whole
 *      supply, locked to the OPERATOR VAULT (prepareStasMint's ownerPubHex override),
 *      so the operator can deliver STAS to buyers.
 * Non-custodial throughout: the wallet signs; the operator only co-signs trades later.
 */
export function StasPoolManage({
  saleId, slug, ticker, name, description, logoUrl, website,
}: {
  saleId: string;
  slug: string;
  ticker: string;
  name?: string;
  description?: string | null;
  logoUrl?: string | null;
  website?: string | null;
}) {
  const { connect } = useWallet();
  const [phase, setPhase] = useState<Phase>('loading');
  const [seed, setSeed] = useState(546);
  const [k, setK] = useState(1);
  const [supply, setSupply] = useState(25); // enough to buy a few + sell without selling out
  const [busy, setBusy] = useState(false);
  const [poolTxid, setPoolTxid] = useState<string | null>(null);
  const [mintTxid, setMintTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const symbol = ticker.replace(/^\$/, '');

  async function refresh() {
    const r = await getStasPool(saleId);
    if (r.ok) {
      setPoolTxid(r.poolTxid);
      if (r.issuanceTxid) { setMintTxid(r.issuanceTxid); setPhase('ready'); }
      else setPhase('mint');
    } else {
      setPhase('deploy');
    }
  }
  useEffect(() => { void refresh(); }, [saleId]);

  async function deploy() {
    setBusy(true); setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });

      const created = await createStasPool({ saleId, identityPubkey: identity, seedReserveSats: seed, k, supply });
      if (!created.ok || !created.scriptHex) throw new Error(created.error ?? 'create failed');

      const res = (await wallet.createAction({
        description: 'deploy stas curve pool',
        outputs: [{ lockingScript: created.scriptHex, satoshis: seed, outputDescription: 'stas reserve covenant' }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      } as never)) as { txid: string };
      const dtxid = res.txid;

      const rec = await markStasPoolDeployed({ saleId, identityPubkey: identity, txid: dtxid, vout: 0, scriptHex: created.scriptHex, reserveSats: seed });
      if (!rec.ok) throw new Error(rec.error);
      setPoolTxid(dtxid);
      setPhase('mint');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function mint() {
    setBusy(true); setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });
      // The client's wallet-derived redemption anchor (tokenId), namespaced to the slug.
      const { publicKey: redeem } = await wallet.getPublicKey({ protocolID: STAS_PROTOCOL, keyID: `${slug}-redeem`, counterparty: 'self' });

      const prep = await prepareStasMint({ saleId, identityPubkey: identity, redemptionPubkey: redeem });
      if (!prep.ok) throw new Error(prep.error);

      // CONTRACT → ISSUE genesis, but the STAS output locks to the OPERATOR VAULT
      // (ownerPubHex override) so the operator can deliver inventory to buyers.
      const { issueStasGenesis } = await import('@launchpad/bsv/genesis');
      const res = await issueStasGenesis(wallet as never, '', 'main', {
        slug, symbol, supply: prep.supply, splittable: true,
        name, description: description ?? undefined, image: logoUrl ?? undefined, website: website ?? undefined,
        ownerPubHex: prep.ownerPubHex,
      });
      if (!res.ok) throw new Error(res.reason);

      // Broadcast CONTRACT first (the issue tx spends it), then ISSUE.
      const bc1 = await broadcastRawTx(res.contractRawTx, res.contractTxid);
      if (!bc1.ok) throw new Error(`contract broadcast rejected: ${bc1.error}`);
      const bc2 = await broadcastRawTx(res.issueRawTx, res.genesisTxid);
      if (!bc2.ok) throw new Error(`issue broadcast rejected: ${bc2.error}`);
      const genesis = bc2.txid || res.genesisTxid;

      const rec = await recordStasMint({ saleId, identityPubkey: identity, issuanceTxid: genesis, tokenId: res.tokenId });
      if (!rec.ok) throw new Error(rec.error);
      setMintTxid(genesis);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="card flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Wallet-STAS curve (operator-gated)</h2>
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.08em] text-faint">ADR-028</span>
      </div>
      <p className="text-sm text-muted">
        Buyers get a real STAS token in their wallet; sells return it. Two owner-signed steps: deploy the reserve
        covenant, then mint the supply into the operator vault. Uses real sats — keep the demo pool tiny.
      </p>

      {phase === 'loading' && <p className="font-mono text-xs text-faint">Loading pool state…</p>}

      {phase === 'deploy' && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-xs text-faint">
              Supply (tokens)
              <input type="number" min={1} value={supply} onChange={(e) => setSupply(Math.floor(Number(e.target.value)))}
                className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-faint">
              k (slope)
              <input type="number" min={1} value={k} onChange={(e) => setK(Math.floor(Number(e.target.value)))}
                className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-faint">
              Seed reserve (sats)
              <input type="number" min={546} value={seed} onChange={(e) => setSeed(Math.floor(Number(e.target.value)))}
                className="rounded-md border border-line bg-elevated/40 px-3 py-2 font-mono text-sm text-fg" />
            </label>
          </div>
          <p className="font-mono text-[0.7rem] text-faint">
            Tiny demo default: supply 5, k 1 → selling out costs ~{(k * (supply * (supply + 1)) / 2).toLocaleString('en-US')} sats total.
          </p>
          <Button onClick={deploy} disabled={busy} block>
            {busy ? 'Deploying…' : 'Step 1 — deploy reserve pool'}
          </Button>
        </>
      )}

      {phase === 'mint' && (
        <>
          <p className="rounded-md border border-teal/40 bg-teal/5 p-3 text-sm text-teal">
            ✓ Reserve pool deployed. Now mint the {symbol} supply into the operator vault so buyers can be served.
          </p>
          <Button onClick={mint} disabled={busy} block>
            {busy ? 'Minting…' : 'Step 2 — mint inventory to vault'}
          </Button>
        </>
      )}

      {phase === 'ready' && (
        <p className="rounded-md border border-line bg-elevated/40 p-3 font-mono text-xs text-muted">
          ✓ Pool live and inventory minted — buyers can trade the curve.
        </p>
      )}

      {poolTxid && (
        <a href={`https://whatsonchain.com/tx/${poolTxid}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-teal underline underline-offset-2">
          pool · {poolTxid.slice(0, 18)}… ↗
        </a>
      )}
      {mintTxid && (
        <a href={`https://whatsonchain.com/tx/${mintTxid}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-teal underline underline-offset-2">
          mint · {mintTxid.slice(0, 18)}… ↗
        </a>
      )}
      {error && <p className="break-words text-sm text-danger">{error}</p>}
    </div>
  );
}
