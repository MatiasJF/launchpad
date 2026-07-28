/// <reference path="../vendor.d.ts" />

/**
 * STAS genesis issuance — the CONTRACT → ISSUE two-transaction mint (ADR-024).
 *
 * A single hand-rolled STAS output has no contract ancestor, so WhatsOnChain's
 * back-to-genesis walker returns `no-genesis` and wallets flag the token
 * counterfeit. A real STAS genesis is two txs:
 *   1. CONTRACT — an output `P2PKH(redeem) + OP_RETURN(schema-JSON)` locking the
 *      whole supply in satoshis. The redeem pkh = hash160(redemption pubkey) =
 *      schema.tokenId; this is the provenance anchor.
 *   2. ISSUE — spends the contract output and creates the STAS token output(s),
 *      each carrying that same redemption pkh in its script tail. This is the
 *      genesis every later transfer traces back to.
 *
 * Non-custodial: the wallet derives the redemption + owner keys (BRC-42) and
 * signs digests; keys never leave it. Both genesis txs sign as plain P2PKH — the
 * STAS engine only activates when a STAS output is later SPENT (transfers). We
 * pack the contract output and the issue-fee funding output into ONE createAction
 * (the wallet funds + change), then hand-build and sign the issue tx.
 *
 * Broadcasting is the caller's job (return the raw txs): the wallet's createAction
 * doesn't reliably propagate, so the caller broadcasts contract → issue to WoC.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Beef, Transaction } from '@bsv/sdk';
import { deriveSelfBrc29P2pkh } from '../settle/twoTx/brc29Address';
import { signP2pkhInput } from '../settle/twoTx/p2pkhInput';

const STAS_PROTOCOL_ID: any = [2, '3241645161d8'];
const STAS_COUNTERPARTY = 'self';
const ORIGINATOR = 'launchpad.issue';

export interface GenesisArgs {
  /** Project slug — namespaces the wallet-derived owner/redeem keys. */
  slug: string;
  /** Ticker symbol, no '$'. */
  symbol: string;
  /** Total supply in whole units = satoshis locked (1 sat = 1 unit). */
  supply: number;
  splittable?: boolean;
  metadata?: string;
  /** Display metadata embedded in the contract OP_RETURN (bounded lengths). */
  name?: string;
  description?: string;
  image?: string;
  website?: string;
}

export type GenesisResult =
  | {
      ok: true;
      genesisTxid: string; // the ISSUE tx — recorded as issuanceTxid (pool source :0)
      contractTxid: string;
      tokenId: string;
      contractRawTx: string;
      issueRawTx: string;
    }
  | { ok: false; reason: string };

async function loadStasDeps(): Promise<{ bsv: any; stas: any; SIGHASH: number }> {
  const bsvMod: any = await import('bsv');
  const bsv = bsvMod.default ?? bsvMod;
  const stasMod: any = await import('stas-js/lib/stas.js');
  const stas = stasMod.default ?? stasMod;
  return { bsv, stas, SIGHASH: stas.sighash };
}

export async function issueStasGenesis(
  wallet: WalletInterface,
  _identityKey: string,
  chain: 'main' | 'test',
  args: GenesisArgs,
): Promise<GenesisResult> {
  let bsv: any, stas: any, SIGHASH: number;
  try {
    ({ bsv, stas, SIGHASH } = await loadStasDeps());
  } catch (err) {
    return { ok: false, reason: `load stas-js/bsv failed: ${msg(err)}` };
  }

  if (!/^[\w-]+$/.test(args.symbol)) return { ok: false, reason: 'symbol must be word characters (no "$")' };
  if (!Number.isInteger(args.supply) || args.supply <= 0) return { ok: false, reason: 'supply must be a positive integer' };
  const splittable = args.splittable ?? true;

  // 1. Derive redemption (issuer/anchor) + owner keys via BRC-42.
  let redemptionPubHex: string, ownerPubHex: string;
  try {
    ({ publicKey: redemptionPubHex } = await wallet.getPublicKey(
      { protocolID: STAS_PROTOCOL_ID, keyID: `${args.slug}-redeem`, counterparty: STAS_COUNTERPARTY } as any,
      ORIGINATOR,
    ));
    ({ publicKey: ownerPubHex } = await wallet.getPublicKey(
      { protocolID: STAS_PROTOCOL_ID, keyID: `${args.slug}-owner`, counterparty: STAS_COUNTERPARTY } as any,
      ORIGINATOR,
    ));
  } catch (err) {
    return { ok: false, reason: `getPublicKey: ${msg(err)}` };
  }

  const redemptionPub = bsv.PublicKey.fromString(redemptionPubHex);
  const redeemPkh: string = bsv.crypto.Hash.sha256ripemd160(redemptionPub.toBuffer()).toString('hex');
  const ownerPkh: string = bsv.crypto.Hash.sha256ripemd160(bsv.PublicKey.fromString(ownerPubHex).toBuffer()).toString('hex');
  const tokenId = redeemPkh; // classic STAS tokenId = hash160(redemption pubkey)

  // 2. Contract output: P2PKH(redeem) + bare OP_RETURN(schema). Anchor = redeemPkh.
  // Contract OP_RETURN schema. tokenId MUST equal hash160(redemption) (the
  // genesis anchor); the rest is free-form display metadata read by wallets /
  // explorers. Lengths are bounded to keep the OP_RETURN small.
  const schema: Record<string, unknown> = {
    name: (args.name || args.symbol).slice(0, 64),
    symbol: args.symbol,
    tokenId,
    totalSupply: args.supply,
    satsPerToken: 1,
    decimals: 0,
  };
  if (args.description) schema.description = args.description.slice(0, 200);
  // Only embed a URL image on-chain — a data-URI upload would bloat the OP_RETURN.
  if (args.image && /^https?:\/\//i.test(args.image)) schema.image = args.image.slice(0, 256);
  if (args.website) schema.website = args.website.slice(0, 256);
  let contractScriptHex: string, stasScriptHex: string;
  try {
    const cs = bsv.Script.fromASM(`OP_DUP OP_HASH160 ${redeemPkh} OP_EQUALVERIFY OP_CHECKSIG`);
    cs.add(bsv.Script.buildDataOut(JSON.stringify(schema))); // bare OP_RETURN (verified)
    contractScriptHex = cs.toHex();
    const hexSymbol = Buffer.from(args.symbol).toString('hex');
    const hexData = args.metadata ? Buffer.from(args.metadata).toString('hex') : undefined;
    stasScriptHex = stas.getStasScript(ownerPkh, redemptionPub, hexData, splittable, hexSymbol);
  } catch (err) {
    return { ok: false, reason: `script build: ${msg(err)}` };
  }

  // 3. Issue-fee funding (a self BRC-29 P2PKH we can sign). Sized to the issue tx.
  const estIssueSize = 300 + Math.ceil(stasScriptHex.length / 2) + 34 + 40;
  const issueFee = Math.max(40, Math.ceil(estIssueSize * 0.05));
  const fundingSats = issueFee + 300; // 300 change back to self
  let fund;
  try {
    fund = await deriveSelfBrc29P2pkh({ wallet, chain, originator: ORIGINATOR });
  } catch (err) {
    return { ok: false, reason: `funding derivation: ${msg(err)}` };
  }

  // 4. TX1 (contract + funding) in one createAction; the wallet funds + change.
  let contractTxid: string, contractRawTx: string;
  try {
    const res: any = await wallet.createAction(
      {
        description: `Issue ${args.symbol} genesis`.slice(0, 50),
        outputs: [
          {
            lockingScript: contractScriptHex,
            satoshis: args.supply,
            outputDescription: `${args.symbol} contract`.slice(0, 50),
            basket: 'stas-contract',
          },
          {
            lockingScript: fund.scriptHex,
            satoshis: fundingSats,
            outputDescription: 'issue funding',
            customInstructions: JSON.stringify({
              derivationPrefix: fund.derivationPrefix,
              derivationSuffix: fund.derivationSuffix,
              forSelf: true,
            }),
          },
        ],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      } as any,
      ORIGINATOR,
    );
    contractTxid = res?.txid;
    if (typeof contractTxid !== 'string' || !/^[0-9a-f]{64}$/i.test(contractTxid)) {
      return { ok: false, reason: `contract createAction returned no txid (got ${JSON.stringify(res?.txid)})` };
    }
    const cb = Beef.fromBinary(res.tx);
    const cbt = cb.findTxid(contractTxid);
    contractRawTx = cbt?.tx ? cbt.tx.toHex() : '';
    if (!contractRawTx) return { ok: false, reason: 'could not extract contract raw tx from BEEF' };
  } catch (err) {
    return { ok: false, reason: `TX1 contract+funding: ${msg(err)}` };
  }

  // 5. TX2 (issue): spend contract(0) + funding(1) → STAS(owner) + P2PKH change.
  let issueRawTx: string, genesisTxid: string;
  try {
    const tx = new bsv.Transaction();
    tx.from({ txId: contractTxid, outputIndex: 0, script: contractScriptHex, satoshis: args.supply });
    tx.from({ txId: contractTxid, outputIndex: 1, script: fund.scriptHex, satoshis: fundingSats });
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(stasScriptHex), satoshis: args.supply }));
    const changeValue = fundingSats - issueFee;
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(fund.scriptHex), satoshis: changeValue }));
    tx.inputs[0].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(contractScriptHex), satoshis: args.supply });
    tx.inputs[1].output = new bsv.Transaction.Output({ script: bsv.Script.fromHex(fund.scriptHex), satoshis: fundingSats });

    // Input 0: the contract output — plain P2PKH to the redemption key.
    const preimage0 = bsv.Transaction.sighash.sighashPreimage(
      tx,
      SIGHASH,
      0,
      bsv.Script.fromHex(contractScriptHex),
      new bsv.crypto.BN(args.supply),
    );
    const digest0 = Array.from(bsv.crypto.Hash.sha256sha256(preimage0) as Buffer) as number[];
    const sig0 = await wallet.createSignature(
      {
        protocolID: STAS_PROTOCOL_ID,
        keyID: `${args.slug}-redeem`,
        counterparty: STAS_COUNTERPARTY,
        hashToDirectlySign: digest0,
      } as any,
      ORIGINATOR,
    );
    const sig0Hex = toHex(sig0.signature) + SIGHASH.toString(16).padStart(2, '0');
    tx.inputs[0].setScript(bsv.Script.fromASM(`${sig0Hex} ${redemptionPubHex}`));

    // Input 1: the funding output — BRC-29 self P2PKH.
    const unlock1 = await signP2pkhInput({
      wallet,
      bsv,
      tx,
      inputIndex: 1,
      derivationPrefix: fund.derivationPrefix,
      derivationSuffix: fund.derivationSuffix,
      sourceScriptHex: fund.scriptHex,
      sourceSatoshis: fundingSats,
      sighashType: SIGHASH,
      originator: ORIGINATOR,
    });
    tx.inputs[1].setScript(bsv.Script.fromHex(unlock1));

    issueRawTx = tx.toString();
    genesisTxid = Transaction.fromHex(issueRawTx).id('hex');
  } catch (err) {
    return { ok: false, reason: `TX2 issue build/sign: ${msg(err)}` };
  }

  return { ok: true, genesisTxid, contractTxid, tokenId, contractRawTx, issueRawTx };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function toHex(bytes: number[] | Uint8Array): string {
  return (Array.isArray(bytes) ? bytes : Array.from(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
