#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function isProjectRoot(dir) {
  return (
    fs.existsSync(path.join(dir, "package.json")) ||
    fs.existsSync(path.join(dir, ".git")) ||
    fs.existsSync(path.join(dir, "Cargo.toml")) ||
    fs.existsSync(path.join(dir, "pyproject.toml"))
  );
}

function hasAkg(dir) {
  return fs.existsSync(path.join(dir, ".astrivya", "akg.db"));
}

const cwd = process.cwd();

if (isProjectRoot(cwd) && !hasAkg(cwd)) {
  console.error("");
  console.error(
    "  \u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591",
  );
  console.error("  \u2591                                                          \u2591");
  console.error("  \u2591   Astrivya \u2014 Local context infrastructure for AI agents      \u2591");
  console.error("  \u2591                                                          \u2591");
  console.error("  \u2591   Index your workspace to let AI agents understand         \u2591");
  console.error("  \u2591   your codebase, decisions, and team context:              \u2591");
  console.error("  \u2591                                                          \u2591");
  console.error("  \u2591     npx @astrivya/cli akg init                            \u2591");
  console.error("  \u2591                                                          \u2591");
  console.error("  \u2591   Or install git hooks to auto-index on commit/merge:     \u2591");
  console.error("  \u2591     npx @astrivya/cli hooks install                        \u2591");
  console.error("  \u2591                                                          \u2591");
  console.error(
    "  \u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591",
  );
  console.error("");
}

// Auto-install git hooks if in a git repo
const { execSync } = require("node:child_process");
try {
  const hookScript = path.resolve(__dirname, "install-git-hooks.js");
  execSync(`node "${hookScript}"`, { cwd, stdio: "inherit" });
} catch {
  // non-fatal
}
