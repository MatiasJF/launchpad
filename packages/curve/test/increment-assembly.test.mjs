import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateAssembledCovenantInput } from '../src/covenant.ts';

const require = createRequire(import.meta.url);
const bsvMod = require('bsv');
const bsv = bsvMod.default ?? bsvMod;

const { ls0, ls1 } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../artifacts/locks.json', import.meta.url)), 'utf8'),
);

const SIGHASH_COVENANT = 0xc3; // ANYONECANPAY | SINGLE | FORKID
const SATS = 1000;

// Reproduces the real increment tx exactly as spike.ts assembles it: a REAL
// covenant outpoint, a SECOND (fee) input, the bsv-js-computed preimage pushed as
// the unlocking script — then checks it validates in @bsv/sdk's interpreter. This
// is the scenario the naive preimage-hash comparison false-alarmed on.
test('assembled increment tx (bsv-js preimage) validates in @bsv/sdk interpreter', () => {
  const covenantTxid = '6225ff674c9c09afb45b656b1f94f0212799ce4b4bbcc96ffcd553b46a14021d';
  const feeTxid = 'b'.repeat(64);

  const tx = new bsv.Transaction();
  tx.addInput(
    new bsv.Transaction.Input({ prevTxId: covenantTxid, outputIndex: 0, script: new bsv.Script() }),
    bsv.Script.fromHex(ls0),
    SATS,
  );
  const dummyP2pkh = '76a914' + '00'.repeat(20) + '88ac';
  tx.addInput(
    new bsv.Transaction.Input({ prevTxId: feeTxid, outputIndex: 1, script: new bsv.Script() }),
    bsv.Script.fromHex(dummyP2pkh),
    600,
  );
  tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(ls1), satoshis: SATS }));

  const preimage = bsv.Transaction.sighash.sighashPreimage(
    tx,
    SIGHASH_COVENANT,
    0,
    bsv.Script.fromHex(ls0),
    new bsv.crypto.BN(SATS),
  );
  tx.inputs[0].setScript(new bsv.Script().add(preimage));

  const rawTx = tx.toString();
  const r = validateAssembledCovenantInput(rawTx, { scriptHex: ls0, satoshis: SATS }, 0);
  assert.equal(r.ok, true, r.error);
});
