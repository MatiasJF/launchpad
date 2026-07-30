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

# Emit the instance locking-script hexes (count 0/1/2) as a test fixture.
cat > "$BUILD/dump-locks.js" <<'JS'
const { buildContractClass } = require('scryptlib');
const C = buildContractClass(require('./artifacts/counter.json'));
const c = new C(0n);
const out = {
  ls0: c.lockingScript.toHex(),
  ls1: c.getNewStateScript({ count: 1n }).toHex(),
  ls2: c.getNewStateScript({ count: 2n }).toHex(),
};
require('fs').writeFileSync('artifacts/locks.json', JSON.stringify(out, null, 2));
console.log('→ wrote artifacts/locks.json');
JS
( cd "$BUILD" && node dump-locks.js )

mkdir -p "$HERE/artifacts"
cp "$BUILD/artifacts/counter.json" "$HERE/artifacts/counter.json"
cp "$BUILD/artifacts/counter.scrypt" "$HERE/artifacts/counter.scrypt"
cp "$BUILD/artifacts/locks.json" "$HERE/artifacts/locks.json"
echo "✓ artifacts refreshed in packages/curve/artifacts/"
