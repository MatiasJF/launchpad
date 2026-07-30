import { LedgerPool, Ledger } from '../src/contracts/ledgerPool';
import { HashedMap, PubKeyHash, toByteString } from 'scrypt-ts';
import artifact from '../artifacts/ledgerPool.json';

async function main() {
  await (LedgerPool as any).loadArtifact(artifact as any);
  console.log('loadArtifact OK');
  const ledger: Ledger = new HashedMap<PubKeyHash, bigint>();
  const inst = new LedgerPool(0n, ledger, 1n, 1000n);
  console.log('instantiated OK; lockingScript bytes =', inst.lockingScript.toHex().length / 2);
  // generate an access path for a new-holder buy
  const owner = PubKeyHash(toByteString('00'.repeat(20)));
  const led: any = (inst as any).ledger;
  led.startTracing();
  console.log('has(owner) =', led.has(owner));
  led.set(owner, 5n);
  led.stopTracing();
  console.log('accessPath =', led.serializedAccessPath());
  console.log('ledger.data() bytes =', (led.data() || '').length / 2);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
