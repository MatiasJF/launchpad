/**
 * stasState.ts — server-side helpers for the Option-B reserve covenant (StasCurvePool,
 * ADR-028). Only the GENESIS script needs scrypt-ts (it bakes in k / supply / operatorPkh);
 * every successor is derived by cheap byte-patching (poolScriptForSold) since the state is
 * just `sold`. So trades never call scrypt-ts — this is only used at deploy.
 */
import { StasCurvePool } from '../src/contracts/stasCurvePool';
import { PubKeyHash, toByteString } from 'scrypt-ts';
import artifact from '../artifacts/stasCurvePool.json';

let loaded = false;
function ensureLoaded(): void {
  if (!loaded) { (StasCurvePool as any).loadArtifact(artifact as any); loaded = true; }
}

/** The genesis reserve-pool locking script to deploy (sold=0), baking in the operator key. */
export function stasGenesisScript(k: bigint, supply: bigint, operatorPkh: string): string {
  ensureLoaded();
  return new StasCurvePool(0n, k, supply, PubKeyHash(toByteString(operatorPkh))).lockingScript.toHex();
}
