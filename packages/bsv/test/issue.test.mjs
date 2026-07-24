import test from 'node:test';
import assert from 'node:assert';
import bsv from 'bsv';
import { planMint } from '../src/issue/index.ts';

test('planMint builds a classic STAS locking script + correct economics', () => {
  const ownerPub = bsv.PrivateKey.fromRandom().toPublicKey().toString();
  const redeemPub = bsv.PrivateKey.fromRandom().toPublicKey().toString();

  const plan = planMint({ symbol: 'ORCA', supply: 1000 }, ownerPub, redeemPub);

  // Classic STAS: starts like P2PKH, with the 88ac69 (OP_VERIFY) marker.
  assert.equal(plan.stasScriptHex.slice(0, 6), '76a914', 'starts like P2PKH');
  assert.equal(plan.stasScriptHex.slice(46, 52), '88ac69', 'classic STAS marker');
  assert.equal(plan.stasScriptHex.slice(6, 46), plan.ownerPkh, 'owner pkh embedded in script');

  // Economics: 1 sat = 1 token.
  assert.equal(plan.tokenSatoshis, 1000, '1 sat = 1 token');
  assert.equal(plan.totalSatsRequired, 2000, 'supply + est fee');
  assert.match(plan.tokenId, /^[0-9a-f]{40}$/, 'token id is a hash160');
  assert.ok(plan.ownerAddress.length > 0, 'derived an owner address');
});

test('planMint rejects a non-positive supply', () => {
  const pub = bsv.PrivateKey.fromRandom().toPublicKey().toString();
  assert.throws(() => planMint({ symbol: 'X', supply: 0 }, pub, pub), /positive integer/);
});
