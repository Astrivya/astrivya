#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const HOOKS = ["post-merge", "post-commit"];

const HOOK_TEMPLATE = `#!/bin/sh
# Astrivya AKG auto-index hook (installed by @astrivya/cli)
# Re-runs akg reindex on git events to keep the knowledge graph current.
AKG_DB=".astrivya/akg.db"
if [ -f "$AKG_DB" ]; then
  npx --no-install @astrivya/cli akg reindex 2>/dev/null || true
fi
`;

function findGitRoot() {
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function install() {
  const gitRoot = findGitRoot();
  if (!gitRoot) {
    console.error("› No .git directory found. Skipping AKG hook installation.");
    return false;
  }

  const hooksDir = path.join(gitRoot, ".git", "hooks");
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  let installed = 0;
  for (const hook of HOOKS) {
    const hookPath = path.join(hooksDir, hook);

    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, "utf-8");
      if (existing.includes("Astrivya AKG auto-index hook")) {
        continue;
      }
      const backup = `${hookPath}.bak`;
      if (!fs.existsSync(backup)) {
        fs.renameSync(hookPath, backup);
        console.error(`› Backed up existing ${hook} hook to ${hook}.bak`);
      }
    }

    fs.writeFileSync(hookPath, HOOK_TEMPLATE, { mode: 0o755 });
    installed++;
  }

  if (installed > 0) {
    console.error(`› Installed AKG auto-index hook${installed > 1 ? "s" : ""}: ${HOOKS.join(", ")}`);
  }
  return true;
}

function uninstall() {
  const gitRoot = findGitRoot();
  if (!gitRoot) return;

  const hooksDir = path.join(gitRoot, ".git", "hooks");
  for (const hook of HOOKS) {
    const hookPath = path.join(hooksDir, hook);
    const backup = `${hookPath}.bak`;

    if (fs.existsSync(hookPath)) {
      const content = fs.readFileSync(hookPath, "utf-8");
      if (content.includes("Astrivya AKG auto-index hook")) {
        fs.unlinkSync(hookPath);
        if (fs.existsSync(backup)) {
          fs.renameSync(backup, hookPath);
          console.error(`› Restored previous ${hook} hook from backup`);
        }
      }
    }
  }
}

const action = process.argv[2];
if (action === "uninstall") {
  uninstall();
} else {
  install();
}
