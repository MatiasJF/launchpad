#!/usr/bin/env bash
# compile.sh — compile the sCrypt covenant to Bitcoin Script.
#
# WHY ISOLATED: scrypt-ts-transpiler is a ts-patch program transform pinned to
# TypeScript ~5.3. Inside this pnpm workspace, pnpm's peer-dep hoisting resolves
# scrypt-cli's `typescript` to 5.9.x, so the transform silently no-ops (emits no
# artifact). We therefore compile in a throwaway npm project with TS 5.3.3 pinned,
# then copy the compiled hex back. sCrypt is a BUILD-TIME dependency only — the app
# runtime uses @bsv/sdk with the committed artifacts, never scrypt-ts. (ADR-026.)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

mkdir -p "$BUILD/src/contracts"
cp "$HERE/src/contracts/"*.ts "$BUILD/src/contracts/"

cat > "$BUILD/package.json" <<'JSON'
{
  "name": "curve-build", "version": "1.0.0", "private": true,
  "dependencies": { "scrypt-ts": "1.4.4" },
  "devDependencies": { "scrypt-cli": "0.2.3", "typescript": "5.3.3" }
}
JSON

cat > "$BUILD/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ESNext", "module": "commonjs", "moduleResolution": "node",
    "experimentalDecorators": true, "esModuleInterop": true,
    "strict": true, "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
JSON

echo "→ installing pinned sCrypt toolchain (TS 5.3.3)…"
( cd "$BUILD" && npm install --no-audit --no-fund >/dev/null 2>&1 )

echo "→ compiling contracts…"
( cd "$BUILD" && npx scrypt-cli compile )

# Emit instance locking-script hexes as test fixtures (state -> script hex).
cat > "$BUILD/dump-locks.js" <<'JS'
const fs = require('fs');
const { buildContractClass } = require('scryptlib');

// Counter (count 0/1/2)
const Counter = buildContractClass(require('./artifacts/counter.json'));
const c = new Counter(0n);
fs.writeFileSync('artifacts/locks.json', JSON.stringify({
  ls0: c.lockingScript.toHex(),
  ls1: c.getNewStateScript({ count: 1n }).toHex(),
  ls2: c.getNewStateScript({ count: 2n }).toHex(),
}, null, 2));
console.log('→ wrote artifacts/locks.json');

// LinearCurvePool — fixed params k=1, supply=1000; lock hex per `sold` value.
const Pool = buildContractClass(require('./artifacts/linearCurvePool.json'));
const K = 1n, SUPPLY = 1000n;
const p = new Pool(0n, K, SUPPLY);
const at = (sold) => p.getNewStateScript({ sold: BigInt(sold) }).toHex();
const soldValues = [0, 1, 10, 15, 25, 128, 200, 1000];
const locks = {};
for (const s of soldValues) locks[String(s)] = s === 0 ? p.lockingScript.toHex() : at(s);
fs.writeFileSync('artifacts/curve-locks.json', JSON.stringify({
  k: Number(K), supply: Number(SUPPLY), locks,
}, null, 2));
console.log('→ wrote artifacts/curve-locks.json');
JS
( cd "$BUILD" && node dump-locks.js )

mkdir -p "$HERE/artifacts"
for f in counter.json counter.scrypt locks.json linearCurvePool.json linearCurvePool.scrypt curve-locks.json; do
  cp "$BUILD/artifacts/$f" "$HERE/artifacts/$f"
done
echo "✓ artifacts refreshed in packages/curve/artifacts/"
