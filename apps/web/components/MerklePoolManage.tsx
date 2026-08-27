'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from './ui/icons';
import { Button, NumberField } from './ui';
import { useWallet } from './WalletProvider';
import { createMerklePool, markMerklePoolDeployed, getMerklePool } from '../lib/merkle-ledger-actions';

type Phase = 'loading' | 'deploy' | 'live';

/**
 * Owner-only control for the TRUSTLESS curve (ADR-030).
 *
 * One signed step, and then the owner is done forever — which is the point. Unlike the Option B
 * pool there is no inventory to mint and no operator key to keep online: buys are keyless, sells
 * are signed by the holder, and graduation can be triggered by anyone. After deploy, the project
 * cannot stop, censor, or reprice a single trade, and neither can we.
 */
export function MerklePoolManage({ saleId, ticker }: { saleId: string; ticker: string }) {
  const { connect } = useWallet();
  const [phase, setPhase] = useState<Phase>('loading');
  const [seed, setSeed] = useState(546);
  const [k, setK] = useState(1);
  const [supply, setSupply] = useState(60);
  const [busy, setBusy] = useState(false);
  const [genesisTxid, setGenesisTxid] = useState<string | null>(null);
  const [sold, setSold] = useState(0);
  const [reserve, setReserve] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await getMerklePool(saleId);
    if ('ok' in r && r.ok) {
      setGenesisTxid(r.genesisTxid);
      setSold(r.sold);
      setReserve(r.reserveSats);
      setSupply(Number(r.supply));
      setPhase('live');
    } else {
      setPhase('deploy');
    }
  }, [saleId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function deploy() {
    setBusy(true); setError(null);
    try {
      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const wallet = await getWalletClient();
      const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true });

      const created = await createMerklePool({ saleId, identityPubkey: identity, k: String(k), supply: String(supply), seedReserveSats: seed });
      if (!created.ok || !created.scriptHex) throw new Error(created.error ?? 'create failed');

      // Output 0 is the covenant. Output 1 announces the pool's terms in an OP_RETURN so the
      // genesis transaction is self-describing — a reader needs the txid and nothing else, not our
      // database. randomizeOutputs stays false because the covenant MUST be output 0.
      const outputs: Record<string, unknown>[] = [
        { lockingScript: created.scriptHex, satoshis: seed, outputDescription: 'merkle ledger covenant' },
      ];
      if (created.announceScriptHex) {
        outputs.push({ lockingScript: created.announceScriptHex, satoshis: 0, outputDescription: 'pool terms (discovery)' });
      }
      const res = (await wallet.createAction({
        description: 'deploy trustless curve pool',
        outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      } as never)) as { txid: string };

      // The action re-resolves this outpoint against the CHAIN before accepting it — a wrong
      // genesis is the one piece of state that would make the pool unreadable.
      const rec = await markMerklePoolDeployed({ saleId, identityPubkey: identity, genesisTxid: res.txid, genesisVout: 0 });
      if (!rec.ok) throw new Error(rec.error);
      setGenesisTxid(res.txid);
      setPhase('live');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const fullRaise = (k * supply * (supply + 1)) / 2;

  return (
    <div className="card flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Trustless curve (no operator)</h2>
        {phase === 'live' && <span className="chip" data-active>live</span>}
      </div>
      <div className="flex items-center gap-2 text-sm text-teal">
        <ShieldCheck className="h-4 w-4" /> Balances live inside the covenant · nobody can stop, censor or reprice a trade
      </div>

      {phase === 'loading' && <p className="text-sm text-muted">Checking the chain…</p>}

      {phase === 'deploy' && (
        <>
          <p className="text-sm text-muted">
            Deploy once and the curve runs itself. Buyers pay the covenant directly, holders sell back with their own
            signature, and once it sells out <span className="text-fg">anyone</span> can release the reserve to your payout
            address — which is fixed at deploy and cannot be changed afterwards, including by you.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-xs text-faint">seed (sats)
              <NumberField value={seed} min={546} onValueChange={setSeed} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-faint">k (slope)
              <NumberField value={k} min={1} onValueChange={setK} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-faint">supply
              <NumberField value={supply} min={1} onValueChange={setSupply} />
            </label>
          </div>
          <p className="font-mono text-xs text-faint">
            a full sell-out raises {fullRaise.toLocaleString()} sats · first token costs {k} · last costs {k * supply}
          </p>
          <Button onClick={deploy} disabled={busy} block>
            {busy ? 'Deploying…' : 'Deploy the curve'}
          </Button>
        </>
      )}

      {phase === 'live' && (
        <>
          <div className="grid grid-cols-3 gap-2 font-mono text-xs">
            <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">sold</div><div className="text-fg">{sold}/{supply}</div></div>
            <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">reserve</div><div className="text-fg">{reserve.toLocaleString()}</div></div>
            <div className="rounded-md border border-line bg-elevated/40 px-2 py-2"><div className="text-faint">ticker</div><div className="text-fg">{ticker}</div></div>
          </div>
          <p className="text-xs text-muted">
            Nothing further is required from you. State is read from the blockchain, not from this site —
            anyone can verify or rebuild the pool from the genesis transaction alone.
          </p>
          {genesisTxid && (
            <a className="font-mono text-xs text-teal underline underline-offset-2" href={`https://whatsonchain.com/tx/${genesisTxid}`} target="_blank" rel="noreferrer">
              genesis {genesisTxid.slice(0, 20)}… ↗
            </a>
          )}
        </>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
