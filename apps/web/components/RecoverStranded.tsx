'use client';

import { useState } from 'react';
import { Button } from './ui';
import { useWallet } from './WalletProvider';
import { broadcastRawTx, getOutputInfo, getSourceBeefDeep, isOutputUnspent } from '../lib/settle-actions';

/** Same value as BRC29_PROTOCOL_ID — the launchpad derives every key under it. */
const PROTOCOL: [2, string] = [2, '3241645161d8'];
const FEE_SATS = 30;

type State = 'idle' | 'working' | 'done';

/**
 * Sweep a coin this wallet can DERIVE but has never ADOPTED (ADR-035).
 *
 * Before ADR-035, a pledge refund was paid to a STAS-protocol ownership key and never
 * internalised, so the sats sat on-chain at an address the wallet could derive but had
 * no record of — the owner's money, invisible in their own wallet. This spends such an
 * output with the derivation that locked it and re-pays it as a BRC-29 self-payment the
 * wallet then takes into its balance.
 *
 * Nothing here can move funds anywhere but back to the connected wallet.
 */
export function RecoverStranded() {
  const { connect } = useWallet();
  const [txid, setTxid] = useState('');
  const [vout, setVout] = useState('0');
  const [keyID, setKeyID] = useState('');
  const [state, setState] = useState<State>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const say = (m: string) => setLog((l) => [...l, m]);

  async function recover() {
    setState('working');
    setError(null);
    setLog([]);
    try {
      if (!/^[0-9a-fA-F]{64}$/.test(txid.trim())) throw new Error('txid must be 64 hex characters');
      if (!keyID.trim()) throw new Error('keyID is required — for a pledge refund it is the sale slug');
      const n = Number(vout);
      if (!Number.isInteger(n) || n < 0) throw new Error('vout must be a non-negative integer');

      await connect();
      const { getWalletClient } = await import('@launchpad/bsv/wallet');
      const { recoverDerivedOutput, internalizeRecovered } = await import('@launchpad/bsv/recover');
      const wallet = await getWalletClient();

      say('checking the output is still unspent…');
      const spent = await isOutputUnspent(txid.trim(), n);
      if (spent.unspent === false) throw new Error(`already spent by ${spent.spentBy ?? 'another transaction'}`);

      say('reading the output from chain…');
      const info = await getOutputInfo(txid.trim(), n);
      if (!info) throw new Error('that outpoint does not exist on-chain');
      say(`found ${info.satoshis} sats`);

      say('loading ancestry…');
      const sourceBeef = await getSourceBeefDeep(txid.trim());
      if (!sourceBeef) throw new Error('could not load the ancestry needed to internalise the result');

      say('deriving the key and signing…');
      const built = await recoverDerivedOutput(wallet as never, 'main', {
        utxo: { txid: txid.trim(), vout: n, satoshis: info.satoshis, scriptHex: info.scriptHex },
        derivation: { protocolID: PROTOCOL, keyID: keyID.trim(), counterparty: 'self' },
        feeSats: FEE_SATS,
        sourceBeef,
      });
      if (!built.ok) throw new Error(built.reason);

      say('broadcasting…');
      const bc = await broadcastRawTx(built.rawTx, built.txid);
      if (!bc.ok) throw new Error(`broadcast rejected: ${bc.error}`);
      say(`broadcast ${bc.txid || built.txid}`);

      say('asking the wallet to adopt it…');
      const adopted = await internalizeRecovered(wallet as never, built.refund);
      say(
        adopted.ok
          ? `✓ ${built.recoveredSats} sats recovered and in your balance`
          : `⚠ on-chain and yours, but the wallet has not adopted it${adopted.reason ? ` (${adopted.reason})` : ''}`,
      );
      setState('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('idle');
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <h2 className="font-semibold">Recover a stranded output</h2>
      <p className="mt-1 text-sm text-muted">
        For sats paid to a key this wallet derives but never adopted — pre-ADR-035 pledge refunds. Spends
        the output and re-pays it to your wallet as a payment it can take into its balance.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-xs text-faint">txid</span>
          <input
            value={txid}
            onChange={(e) => setTxid(e.target.value)}
            placeholder="64 hex characters"
            className="rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs text-fg"
          />
        </label>
        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="font-mono text-xs text-faint">vout</span>
            <input
              value={vout}
              onChange={(e) => setVout(e.target.value)}
              className="rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs text-fg"
            />
          </label>
          <label className="flex flex-[3] flex-col gap-1">
            <span className="font-mono text-xs text-faint">keyID (the sale slug, for a pledge refund)</span>
            <input
              value={keyID}
              onChange={(e) => setKeyID(e.target.value)}
              placeholder="basket-check-…"
              className="rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs text-fg"
            />
          </label>
        </div>
        <Button variant="primary" onClick={recover} disabled={state === 'working'}>
          {state === 'working' ? 'Recovering…' : 'Recover'}
        </Button>
      </div>

      {log.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 font-mono text-xs text-muted">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {error && <p className="mt-3 break-words text-xs text-danger">⚠ {error}</p>}
    </div>
  );
}
