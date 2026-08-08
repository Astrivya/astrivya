#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLOUD_DIR="${ROOT}/../astrivya-infra"

echo "=== Astrivya Dev Environment ==="

# --- Pre-check: cloud repo ---
if [ ! -d "$CLOUD_DIR" ]; then
  echo "ERROR: astrivya-infra repo not found at $CLOUD_DIR"
  echo "Clone it first: git clone git@github.com:astrivya/astrivya-infra.git \"$CLOUD_DIR\""
  exit 1
fi

# --- Install & start cloud server ---
echo "Starting cloud server..."
cd "$CLOUD_DIR/cloud"
npm ci --silent 2>/dev/null
npm run dev &
CLOUD_PID=$!

# --- Install & start mcp-gateway ---
echo "Starting MCP gateway..."
cd "$CLOUD_DIR/mcp-gateway"
npm ci --silent 2>/dev/null
npm run dev &
GATEWAY_PID=$!
cd "$ROOT"

# --- Install OSS deps ---
echo "Installing OSS dependencies..."
npm ci --silent 2>/dev/null

# --- Export env vars for all watchers ---
export ASTRIVYA_CLOUD_URL=http://localhost:3000
export ASTRIVYA_BASE_URL=http://localhost:3000

# --- Start OSS watchers ---
echo "Starting OSS package watchers (cloud → $ASTRIVYA_CLOUD_URL)..."
npx concurrently \
  --names "akg-core,akg-indexer,mcp-server,cli" \
  --prefix-colors "cyan,green,yellow,magenta" \
  "npm -w packages/akg-core run dev" \
  "npm -w packages/akg-indexer run dev" \
  "npm -w packages/mcp-server run dev" \
  "npm -w packages/cli run dev"

# --- Cleanup ---
echo "Shutting down cloud server and MCP gateway..."
kill $CLOUD_PID $GATEWAY_PID 2>/dev/null
wait $CLOUD_PID $GATEWAY_PID 2>/dev/null
echo "Done."
