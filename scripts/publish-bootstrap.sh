#!/usr/bin/env bash
# One-time bootstrap: publish the initial 0.1.0 of all six packages so that
# release-please has a clean baseline for subsequent automated releases.
# Run this once (with NPM_TOKEN in env) before relying on the automated pipeline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm ci
npm audit --omit=dev --audit-level=high
npm run build:all

# Dependency order: bases (akg-core, plugin-api) before dependents.
order="packages/akg-core packages/plugin-api packages/plugin-runtime packages/akg-indexer packages/mcp-server packages/cli"

for p in $order; do
  pkg=$(node -p "require('./$p/package.json').name")
  echo "=== publishing $pkg ($p) @0.1.0 ==="
  (cd "$p" && npm publish --access public)
done

git add packages/*/package.json package-lock.json
git tag akg-core@0.1.0 plugin-api@0.1.0 plugin-runtime@0.1.0 akg-indexer@0.1.0 mcp-server@0.1.0 cli@0.1.0

echo ""
echo "=== Bootstrap complete ==="
echo "Push initial tags when ready:"
echo "  git push origin akg-core@0.1.0 plugin-api@0.1.0 plugin-runtime@0.1.0 akg-indexer@0.1.0 mcp-server@0.1.0 cli@0.1.0"
echo "After this, release-please drives all future releases automatically."