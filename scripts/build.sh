#!/bin/bash
# Build src/ → lib/ with the local TypeScript compiler (no DSH checkout needed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -x node_modules/.bin/tsc ]; then
  exec node_modules/.bin/tsc -p tsconfig.json
fi
exec tsc -p tsconfig.json
