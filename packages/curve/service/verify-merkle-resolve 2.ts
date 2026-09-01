/**
 * verify-merkle-resolve.ts — rebuild an ADR-030 pool from CHAIN ALONE.
 *
 * Runs against the real mainnet pool created by `verify-merkle-mainnet.ts`, whose history already
 * exercises every path worth reconstructing: two appends, an UPDATE of an existing slot, a
 * holder-signed sell, a buy-out, and a graduation. Nothing local is used — no DB, no saved state,
 * no record of who the second holder was (that key was random and is gone). The only inputs are
 * the genesis outpoint and the pool's public terms.
 *
 * Costs nothing to run: it only reads the chain.
 *
 *   node service/dist/service/verify-merkle-resolve.js [genesisTxid] [supply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrivateKey } from '@bsv/sdk';
import { resolveMerkleLedgerPool } from './resolveMerkleLedgerPool';
import { parseMerkleOp } from '../src/merkleLedgerReconstruct';
import { PoolTerms } from './merkleLedgerState';

// the pool from the ADR-030 mainnet lifecycle run (k=1, supply=80, payout = the test client)
const DEFAULT_GENESIS = '4c6faf9753fc1228f270453429da2974d2dde0b854b90f8b873bbdb5fd4b7837';
const genesisTxid = process.argv[2] && /^[0-9a-f]{64}$/i.test(process.argv[2]) ? process.argv[2] : DEFAULT_GENESIS;
const SUPPLY = BigInt(process.argv[3] ?? '80');

const ENV_PATH = path.resolve(__dirname, '../../../../../apps/web/.env');
const keyHex = (fs.readFileSync(ENV_PATH, 'utf8').match(/^TEST_CLIENT_KEY=([0-9a-fA-F]{64})/m)?.[1] ?? '').trim();
if (!keyHex) { console.error('❌ TEST_CLIENT_KEY missing'); process.exit(1); }
const pkhA = Buffer.from(PrivateKey.fromString(keyHex, 'hex').toPublicKey().toHash() as number[]).toString('hex');
const TERMS: PoolTerms = { k: 1n, supply: SUPPLY, payoutPkh: pkhA };

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  [PASS]', n); } else { fail++; console.log('  [FAIL]', n, extra); }
};
const log = (s: string) => console.log(s);

async function main() {
  log(`▶ RESOLVE ${genesisTxid.slice(0, 16)}… from chain only (k=1 supply=${SUPPLY})`);
  log(`  holder A is ${pkhA.slice(0, 12)}… (the test client); holder B is UNKNOWN locally`);

  const r = await resolveMerkleLedgerPool(genesisTxid, TERMS);
  if ('error' in r) { check('resolveMerkleLedgerPool succeeded', false, r.error); }
  else {
    log(`\n  hops        : ${r.hops}`);
    log(`  graduated   : ${r.graduated}`);
    log(`  sold        : ${r.sold}/${SUPPLY}`);
    log(`  holderCount : ${r.holderCount}`);
    log(`  root        : ${r.rootHex.slice(0, 24)}…`);
    log(`  history     : ${r.history.map((o) => `slot${o.slotIndex}${o.isNew ? '*' : ''}${o.delta > 0n ? '+' : ''}${o.delta}`).join(' ')}`);
    log(`  slots       : ${r.slots.map((s) => `[${s.index}] ${s.ownerPkh.slice(0, 10)}…=${s.balance}`).join(' · ')}`);

    check('walked the chain to a terminal graduation', r.graduated === true);
    check('sold == supply (the curve was bought out)', r.sold === SUPPLY, `${r.sold}`);
    check('every hop was parsed (6 pool spends: 4 buys, 1 sell, 1 graduate)', r.hops === 6, `${r.hops}`);
    check('history has 5 ledger ops (graduation carries none)', r.history.length === 5, `${r.history.length}`);

    // the ops as they actually happened on chain
    const [o1, o2, o3, o4, o5] = r.history;
    check('op 1 appended slot 0', o1?.isNew === true && o1.slotIndex === 0 && o1.delta === 25n, JSON.stringify(o1));
    check('op 2 appended slot 1', o2?.isNew === true && o2.slotIndex === 1 && o2.delta === 25n, JSON.stringify(o2));
    check('op 3 UPDATED slot 0 (no new slot)', o3?.isNew === false && o3.slotIndex === 0 && o3.delta === 10n, JSON.stringify(o3));
    check('op 4 was the sell (negative delta, slot 0)', o4?.delta === -11n && o4.slotIndex === 0, JSON.stringify(o4));
    check('op 5 was the buy-out on slot 1', o5?.isNew === false && o5.slotIndex === 1 && o5.delta === 31n, JSON.stringify(o5));

    check('only 2 slots were ever allocated', r.holderCount === 2, `${r.holderCount}`);
    check('holder A balance reconstructed (25 + 10 − 11)', r.balances[pkhA] === 24n, `${r.balances[pkhA]}`);
    const bPkh = Object.keys(r.balances).find((p) => p !== pkhA) ?? '';
    log(`  recovered holder B from chain: ${bPkh.slice(0, 12)}… = ${r.balances[bPkh]}`);
    check('holder B recovered from chain alone', /^[0-9a-f]{40}$/.test(bPkh));
    check('holder B balance reconstructed (25 + 31)', r.balances[bPkh] === 56n, `${r.balances[bPkh]}`);
    check('sold == sum of balances (the reserve invariant)',
      r.sold === Object.values(r.balances).reduce((a, b) => a + b, 0n));

    // the parser is the risky part; confirm it is not accepting arbitrary bytes
    check('parser rejects a non-ledger script', parseMerkleOp('76a914' + '00'.repeat(20) + '88ac') === null);
    check('parser rejects empty input', parseMerkleOp('') === null);
  }

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('❌', e instanceof Error ? e.message : String(e)); process.exit(1); });
