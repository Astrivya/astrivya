#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_DIR="${ROOT}/../astrivya-oss-publish"

if [ -d "$PUBLIC_DIR" ]; then
  echo "ERROR: $PUBLIC_DIR already exists. Remove it first."
  exit 1
fi

echo "=== Preparing OSS-only snapshot ==="

# Clone self
git clone "$ROOT" "$PUBLIC_DIR"
cd "$PUBLIC_DIR"

# Strip private files and internal docs
rm -f .env.local
rm -f .env
rm -f .npmrc
rm -rf plans/
rm -rf docs/internal/
rm -rf .astrivya/
find . -type d -name .astrivya -prune -exec rm -rf {} +
rm -f docs/vscode-extension-strategy.md
find . -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) -delete

# Reset git to a clean state
rm -rf .git
git init
git checkout -b main
git add -A
git commit -m "chore: initial OSS release snapshot"

echo ""
echo "=== Done ==="
echo "OSS snapshot ready at: $PUBLIC_DIR"
echo ""
echo "To publish:"
echo "  cd $PUBLIC_DIR"
echo "  git remote add origin git@github.com:astrivya/astrivya.git"
echo "  git push origin main --force"
