/* eslint-disable no-console */
/**
 * flat-key-wallet.mjs — a MINIMAL `@bsv/sdk` WalletInterface shim backed by the
 * operator FLAT key + WhatsOnChain, for the SELF-DRIVING e2e-stas harness ONLY.
 *
 * WHY: `@bsv/wallet-toolbox`'s remote storage corrupts under the harness workload —
 * once the operator holds a chain of unconfirmed txs it rejects every `createAction`
 * with "merged Beef failed validation" (it has broken both the operator toolbox and
 * BSV Desktop, twice each). The flat-key + WoC path is the only reliable way to test.
 *
 * This shim lets the harness play EVERY non-operator wallet role (admin deploy+mint,
 * buyer payment, seller STAS return) from the single operator flat key, exactly like
 * the operator delivery/refund fee path already does. It implements just enough of
 * the BRC-100 `WalletInterface` that the STAS setup functions call:
 *
 *   CRYPTO (inherited from @bsv/sdk `ProtoWallet`, backed by a `KeyDeriver` over the
 *   flat key — the SAME BRC-42/BRC-29 derivations the toolbox Wallet does):
 *     • getPublicKey / createSignature / createHmac / verifyHmac  (createNonce, the
 *       BRC-29 funding-address derivation, and every owner/redeem key ride on these)
 *     • encrypt / decrypt / verifySignature (unused here but free from ProtoWallet)
 *
 *   BLOCKCHAIN (implemented here — the flat-key + WoC part):
 *     • createAction  — funds the requested outputs from the operator BASE-address
 *       (`76a914<basePkh>88ac`) UTXOs via WoC, signs the P2PKH inputs with the flat
 *       key (SIGHASH_ALL|FORKID), appends change back to base, builds the atomic
 *       ancestry BEEF, and broadcasts the whole unconfirmed chain parents-first
 *       (multi-pass) so outputs are live and the base-UTXO spend is reflected on WoC
 *       for the next call. Returns `{ txid, tx: <atomicBEEF number[]> }` — the shape
 *       genesis / funding / the harness deploy all consume (both
 *       `Transaction.fromAtomicBEEF` and `Beef.fromBinary` parse it).
 *     • listOutputs   — returns the operator base UTXOs from WoC (powers balance).
 *     • internalizeAction — best-effort no-op (the harness broadcasts + tracks its
 *       own outpoints on-chain; transferStas ignores this result anyway).
 *     • getNetwork / getHeight / getVersion / isAuthenticated — trivial.
 *
 * The operator key stays LOCAL to this script (same trust boundary as operator-fund.mjs);
 * it is NEVER imported into packages/*. WoC I/O is injected by the harness (getOperatorBaseUtxos,
 * getSourceBeefDeep, broadcastBeefChain) so the network layer stays where it already lives.
 */
import { KeyDeriver, PrivateKey, ProtoWallet, Beef, Transaction } from '@bsv/sdk';
import {
  selectOperatorFeeInputs,
  signOperatorP2pkhInput,
  p2pkhScriptHexForPkh,
} from '@launchpad/bsv/settle/base-funding';

const FEE_RATE = 0.1; // sat/byte — covenant-safe (was 0.05; underpaid the 3.5KB deploy tx)
const MIN_FEE = 40; // sats — miner floor so a tiny tx still relays
/** Serialized size of one output given its locking-script byte length. */
const outputBytes = (scriptLen) => 8 + (scriptLen < 0xfd ? 1 : scriptLen <= 0xffff ? 3 : 5) + scriptLen;
const SIGHASH_ALL_FORKID = 0x41;

let BSV; // bsv-js v1, lazily loaded (same lib the STAS assembly uses)
async function loadBsv() {
  if (!BSV) {
    const m = await import('bsv');
    BSV = m.default ?? m;
  }
  return BSV;
}

/** Build a raw low-S DER `signDigest(digestHex) → derHex` callback over the flat key. */
function makeSignDigest(keyHex) {
  return async function signDigest(digestHex) {
    const bsv = await loadBsv();
    const p = bsv.PrivateKey.fromString(keyHex);
    const sig = bsv.crypto.ECDSA.sign(Buffer.from(digestHex, 'hex'), p);
    const N = bsv.crypto.Point.getN();
    if (sig.s.gt(N.div(new bsv.crypto.BN(2)))) sig.s = N.sub(sig.s); // low-S
    return sig.toDER().toString('hex');
  };
}

/**
 * A flat-key WalletInterface. `crypto` comes from ProtoWallet (KeyDeriver over the
 * operator key); `createAction`/`listOutputs` fund from the operator base address
 * over WoC using the injected callbacks.
 */
export class FlatKeyWallet extends ProtoWallet {
  /**
   * @param {string} keyHex 64-char operator private key hex.
   * @param {object} deps
   * @param {'main'|'test'} deps.chain
   * @param {string} deps.basePkh operator base-address pkh (hash160 of operator pubkey).
   * @param {string} deps.baseAddress operator base P2PKH address (for balance / listOutputs).
   * @param {string} deps.operatorPubHex operator compressed pubkey hex (for P2PKH unlocks).
   * @param {() => Promise<{txid:string,vout:number,satoshis:number}[]>} deps.fetchUtxos WoC base UTXOs.
   * @param {(txid:string) => Promise<number[]|null>} deps.fetchBeef ancestry BEEF (getSourceBeefDeep).
   * @param {(beef:number[], txid?:string) => Promise<{ok:boolean,txid?:string,error?:string}>} deps.broadcastChain parents-first flush.
   */
  constructor(keyHex, deps) {
    super(new KeyDeriver(new PrivateKey(keyHex, 'hex')));
    this.chain = deps.chain ?? 'main';
    this.basePkh = deps.basePkh.toLowerCase();
    this.baseAddress = deps.baseAddress;
    this.operatorPubHex = deps.operatorPubHex;
    this.baseScriptHex = p2pkhScriptHexForPkh(this.basePkh);
    this._signDigest = makeSignDigest(keyHex);
    this._fetchUtxosRaw = deps.fetchUtxos;
    this._fetchBeefRaw = deps.fetchBeef;
    this._broadcastChain = deps.broadcastChain;

    // Local, in-run bookkeeping. WoC's mempool-aware `getOperatorBaseUtxos` is the
    // AUTHORITATIVE source of spendable base UTXOs (it excludes anything a pending tx
    // already spent — including spends made OUTSIDE this shim, e.g. the operator
    // DELIVER/REFUND fee path). We only layer two PURELY-SUBTRACTIVE / LOCAL-ONLY aids
    // on top, never an additive optimistic UTXO (that once re-introduced an
    // externally-spent input → txn-mempool-conflict):
    //   • `_spent`  — inputs THIS shim just consumed, dropped from the next selection
    //                 in case WoC hasn't yet indexed our spend (lag window guard).
    //   • `_createdBeef` — ancestry BEEF of every tx we built, served locally for our
    //                 own just-broadcast change (WoC may not serve its /hex yet).
    this._spent = new Set(); // "txid:vout"
    this._createdBeef = new Map(); // txid -> non-atomic BEEF bytes (number[])
  }

  // ── WoC selection wrapper (WoC authoritative; only SUBTRACT locally-spent) ──────
  async _fetchUtxos() {
    let woc = [];
    try {
      woc = await this._fetchUtxosRaw();
    } catch {
      woc = [];
    }
    return woc.filter((u) => !this._spent.has(`${u.txid}:${u.vout}`));
  }

  async _fetchBeef(txid) {
    const local = this._createdBeef.get(txid.toLowerCase());
    if (local) return local; // ancestry of a tx WE just made — no WoC round-trip / lag
    return this._fetchBeefRaw(txid);
  }

  // ── createAction: the flat-key funding + broadcast path ────────────────────────
  async createAction(args, _originator) {
    const outputs = Array.isArray(args?.outputs) ? args.outputs : [];
    if (outputs.length === 0) throw new Error('flat-key createAction: no outputs requested');
    for (const o of outputs) {
      if (typeof o.lockingScript !== 'string' || !/^[0-9a-fA-F]+$/.test(o.lockingScript)) {
        throw new Error('flat-key createAction: output.lockingScript must be hex');
      }
      if (!Number.isInteger(o.satoshis) || o.satoshis < 0) {
        throw new Error(`flat-key createAction: bad output.satoshis ${o.satoshis}`);
      }
    }

    const sumOut = outputs.reduce((s, o) => s + Number(o.satoshis), 0);
    // Size the fee from the ACTUAL serialized bytes (money-critical): sum each
    // requested output at its REAL locking-script length — so the ~3.5 KB stas curve
    // DEPLOY covenant output is counted, not flattened to 34 B — plus a P2PKH change
    // output, plus N ~148 B P2PKH fee inputs. The old flat 34 B/output priced the
    // 3.5 KB deploy tx at ~40 sats (0.011 sat/B) → EVICTED. Inputs unknown until
    // selection → over-request at the cap so selection never comes up short; the real
    // fee uses the actual input count.
    const requestedOutBytes = outputs.reduce((s, o) => s + outputBytes(o.lockingScript.length / 2), 0);
    const est = (nIn) => Math.max(MIN_FEE, Math.ceil((4 + 4 + 3 + nIn * 148 + requestedOutBytes + outputBytes(25)) * FEE_RATE));
    const need = sumOut + est(5) + 1;

    const sel = await selectOperatorFeeInputs({
      basePkh: this.basePkh,
      needSats: need,
      fetchUtxos: () => this._fetchUtxos(),
      fetchBeef: (txid) => this._fetchBeef(txid),
    });
    if (!sel.ok) throw new Error(`flat-key createAction funding failed: ${sel.reason}`);

    const fee = est(sel.feeInputs.length);
    const change = sel.totalSats - sumOut - fee;
    if (change < 0) {
      throw new Error(`flat-key createAction: selected ${sel.totalSats} sats < outputs ${sumOut} + fee ${fee}`);
    }

    const bsv = await loadBsv();
    const tx = new bsv.Transaction();
    for (const fi of sel.feeInputs) {
      tx.from({ txId: fi.txid, outputIndex: fi.vout, script: fi.scriptHex, satoshis: fi.satoshis });
    }
    // Requested outputs FIRST, in order (randomizeOutputs:false) — genesis/funding
    // depend on output 0 being the contract/funding output. Change is appended last.
    for (const o of outputs) {
      tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(o.lockingScript), satoshis: Number(o.satoshis) }));
    }
    const hasChange = change >= 1;
    if (hasChange) {
      tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(this.baseScriptHex), satoshis: change }));
    }
    for (const [i, fi] of sel.feeInputs.entries()) {
      tx.inputs[i].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(fi.scriptHex), satoshis: fi.satoshis });
    }
    for (const [i, fi] of sel.feeInputs.entries()) {
      const unlock = await signOperatorP2pkhInput({
        bsv,
        tx,
        inputIndex: i,
        sourceScriptHex: fi.scriptHex,
        sourceSatoshis: fi.satoshis,
        sighashType: SIGHASH_ALL_FORKID,
        operatorPubHex: this.operatorPubHex,
        signFeeDigest: this._signDigest,
      });
      tx.inputs[i].setScript(bsv.Script.fromHex(unlock));
    }

    const rawTx = tx.toString();
    const sdkTx = Transaction.fromHex(rawTx);
    const txid = sdkTx.id('hex');

    // Atomic ancestry BEEF: each input's ancestry (anchored to confirmed roots) + this tx.
    const beef = new Beef();
    for (const fi of sel.feeInputs) beef.mergeBeef(fi.beef);
    beef.mergeTransaction(sdkTx);
    const atomicBeef = beef.toBinaryAtomic(txid);

    // Broadcast the whole unconfirmed chain (parents-first, multi-pass) so the outputs
    // are live and the base-UTXO spend propagates before the next createAction selects.
    const bc = await this._broadcastChain(atomicBeef, txid);
    if (!bc.ok) throw new Error(`flat-key createAction broadcast rejected: ${bc.error}`);

    // Record in-run state: inputs we consumed (subtractive guard) + this tx's ancestry
    // (served locally for our own change until WoC indexes it).
    for (const fi of sel.feeInputs) this._spent.add(`${fi.txid}:${fi.vout}`);
    this._createdBeef.set(txid.toLowerCase(), beef.toBinary());

    // Let WoC index this tx (its outputs become the next call's spendable base UTXOs,
    // and the consumed input becomes mempool-spent) before the next selection.
    await new Promise((r) => setTimeout(r, 2000));

    return { txid, tx: atomicBeef, noSendChange: [], signableTransaction: undefined };
  }

  // ── listOutputs: the operator base UTXOs (powers walletBalanceSats) ────────────
  async listOutputs(_args, _originator) {
    const utxos = await this._fetchUtxos();
    return {
      totalOutputs: utxos.length,
      outputs: utxos.map((u) => ({
        outpoint: `${u.txid}.${u.vout}`,
        satoshis: u.satoshis,
        lockingScript: this.baseScriptHex,
        spendable: true,
        basket: 'default',
      })),
    };
  }

  // ── best-effort / trivial WalletInterface members the flows may touch ──────────
  async internalizeAction(_args, _originator) {
    // The harness broadcasts + tracks its own outpoints on-chain; transferStas wraps
    // this in try/catch and ignores the result. No wallet-side bookkeeping to do.
    return { accepted: true };
  }

  async getNetwork(_args, _originator) {
    return { network: this.chain === 'main' ? 'mainnet' : 'testnet' };
  }

  async getHeight(_args, _originator) {
    try {
      const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info', { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        if (Number.isInteger(j?.blocks)) return { height: j.blocks };
      }
    } catch {
      /* non-fatal — height is unused by the STAS flows */
    }
    return { height: 0 };
  }

  async getVersion(_args, _originator) {
    return { version: 'flat-key-wallet-1.0.0' };
  }

  async isAuthenticated(_args, _originator) {
    return { authenticated: true };
  }
}

/** Flat-key sum of the operator base-address spendable UTXOs (drop-in for walletBalanceSats). */
export async function flatKeyBalanceSats(wallet) {
  const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 }, 'launchpad');
  return (outputs ?? []).reduce((sum, o) => sum + Number(o.satoshis ?? 0), 0);
}
