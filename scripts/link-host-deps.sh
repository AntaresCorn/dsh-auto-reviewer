#!/bin/bash
# Link node_modules/@deepseek-ai to the installed dsh host scope so the plugin
# uses the same physical packages as the running harness (no duplicate copies).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NPM_ROOT="$(npm root -g 2>/dev/null || true)"
if [ -z "$NPM_ROOT" ] || [ ! -d "$NPM_ROOT" ]; then
  echo "error: cannot resolve npm global root" >&2
  exit 1
fi
DSH_SCOPE="$NPM_ROOT/@deepseek-ai/dsh/node_modules/@deepseek-ai"
if [ ! -d "$DSH_SCOPE" ] || [ ! -d "$DSH_SCOPE/dsh-llm" ]; then
  echo "error: cannot locate the @deepseek-ai host scope (got $DSH_SCOPE)" >&2
  exit 1
fi
mkdir -p node_modules
rm -rf node_modules/@deepseek-ai
ln -s "$DSH_SCOPE" node_modules/@deepseek-ai
echo "linked node_modules/@deepseek-ai -> $DSH_SCOPE"
