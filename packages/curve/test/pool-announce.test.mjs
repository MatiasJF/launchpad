/**
 * pool-announce.test.mjs — the on-chain pool announcement (ADR-030 discovery).
 *
 * The announcement is UNSIGNED data anyone can write, so these tests are mostly about the parser
 * being strict: it is run against every output of a candidate transaction, and anything it wrongly
 * accepts becomes terms a client would try to resolve with. Safety does not come from the parser
 * (the covenant script check does that) — but a sloppy parser still turns a stranger's OP_RETURN
 * into a confusing error instead of a clean "not a pool".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePoolAnnouncement, decodePoolAnnouncement, findAnnouncement,
  ANNOUNCE_PREFIX, ANNOUNCE_KIND,
} from '../src/poolAnnounce.ts';

const PKH = '6dfd415a417ddbf485d78e0118c9aa54900894f6';

test('round-trips the terms a client needs', () => {
  const a = { k: '1', supply: '60', payoutPkh: PKH, ticker: '$tr2' };
  const back = decodePoolAnnouncement(encodePoolAnnouncement(a));
  assert.deepEqual(back, a);
});

test('round-trips without the optional ticker', () => {
  const back = decodePoolAnnouncement(encodePoolAnnouncement({ k: '7', supply: '1000', payoutPkh: PKH }));
  assert.equal(back.k, '7');
  assert.equal(back.supply, '1000');
  assert.equal(back.payoutPkh, PKH);
  assert.equal(back.ticker, undefined);
});

test('handles large k and supply (no numeric truncation)', () => {
  const big = { k: '999999999999', supply: '18446744073709551615', payoutPkh: PKH };
  assert.deepEqual(decodePoolAnnouncement(encodePoolAnnouncement(big)), { ...big, ticker: undefined });
});

test('is provably unspendable: starts OP_FALSE OP_RETURN', () => {
  const hex = encodePoolAnnouncement({ k: '1', supply: '60', payoutPkh: PKH });
  assert.equal(hex.slice(0, 4), '006a');
});

test('rejects anything that is not an announcement', () => {
  assert.equal(decodePoolAnnouncement(''), null);
  assert.equal(decodePoolAnnouncement('76a914' + PKH + '88ac'), null, 'a P2PKH is not an announcement');
  assert.equal(decodePoolAnnouncement('006a' + '04' + Buffer.from('junk').toString('hex')), null, 'OP_RETURN alone is not one');
  assert.equal(decodePoolAnnouncement('not-hex'), null);
  assert.equal(decodePoolAnnouncement('006a'), null, 'no fields');
});

test('rejects a different protocol or version', () => {
  const good = encodePoolAnnouncement({ k: '1', supply: '60', payoutPkh: PKH });
  const wrongPrefix = good.replace(Buffer.from(ANNOUNCE_PREFIX).toString('hex'), Buffer.from('XXXXX').toString('hex'));
  assert.equal(decodePoolAnnouncement(wrongPrefix), null);
  const wrongKind = good.replace(Buffer.from(ANNOUNCE_KIND).toString('hex'), Buffer.from('mlp9').toString('hex'));
  assert.equal(decodePoolAnnouncement(wrongKind), null);
});

test('rejects malformed field values rather than passing them on', () => {
  assert.throws(() => encodePoolAnnouncement({ k: '1', supply: '60', payoutPkh: 'abcd' }), /20 bytes/);
  assert.throws(() => encodePoolAnnouncement({ k: '-1', supply: '60', payoutPkh: PKH }), /decimal integers/);
  assert.throws(() => encodePoolAnnouncement({ k: '1', supply: '1.5', payoutPkh: PKH }), /decimal integers/);
  // a truncated push must not yield a half-read announcement
  const good = encodePoolAnnouncement({ k: '1', supply: '60', payoutPkh: PKH });
  assert.equal(decodePoolAnnouncement(good.slice(0, good.length - 10)), null);
});

test('findAnnouncement picks it out from among ordinary outputs', () => {
  const ann = encodePoolAnnouncement({ k: '1', supply: '60', payoutPkh: PKH, ticker: '$tr2' });
  const outputs = [
    { scriptHex: '76a914' + '11'.repeat(20) + '88ac' }, // the covenant / a payment
    { scriptHex: ann },
    { scriptHex: '76a914' + '22'.repeat(20) + '88ac' }, // change
  ];
  assert.equal(findAnnouncement(outputs).ticker, '$tr2');
  assert.equal(findAnnouncement([{ scriptHex: '76a914' + '11'.repeat(20) + '88ac' }]), null);
});

test('a hostile announcement is still just data — it carries no authority', () => {
  // Anyone can write one claiming any terms. Nothing here rejects it, and nothing should: the
  // covenant-script check in resolveMerklePoolFromGenesis is what refuses a lie, because the
  // genesis script commits to k, supply and payoutPkh.
  const lie = encodePoolAnnouncement({ k: '1', supply: '1', payoutPkh: 'ff'.repeat(20) });
  const parsed = decodePoolAnnouncement(lie);
  assert.equal(parsed.payoutPkh, 'ff'.repeat(20), 'parsing succeeds — verification happens elsewhere');
});
