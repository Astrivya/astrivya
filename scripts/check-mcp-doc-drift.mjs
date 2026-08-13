#!/usr/bin/env node
/**
 * MCP doc-drift checker.
 *
 * Enforces that every place that documents the MCP server's tool surface stays
 * in sync with the single source of truth: CORE_TOOL_DEFINITIONS in
 * packages/mcp-server/src/schemas.ts.
 *
 * Checks:
 *   1. README.md tools table == CORE_TOOL_DEFINITIONS tool names (set equality)
 *   2. README "Provides N tools" count string
 *   3. mcp-server package.json description "N tools"
 *   4. .opencode skill SKILL.md tools table + "N tools + 4 resources" string
 *   5. astrivya-docs SKILL.md tools table + count strings
 *   6. Resources tables == 4 rows (README + both SKILL copies)
 *
 * The two SKILL.md copies live outside this repo (../.opencode and
 * ../astrivya-docs from the repo root). They are checked when present and
 * skipped with a notice otherwise (e.g. in GitHub CI, which only checks out
 * this repo). README.md and package.json are always required.
 *
 * Exit code 0 = consistent, 1 = drift found.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMAS = path.join(repoRoot, "packages", "mcp-server", "src", "schemas.ts");
const README = path.join(repoRoot, "packages", "mcp-server", "README.md");
const MCP_PKG = path.join(repoRoot, "packages", "mcp-server", "package.json");
// Outside the repo — only checked when the sibling workspace is present.
const OPENCODE_SKILL = path.join(repoRoot, "..", ".opencode", "skills", "agent-onboarding", "SKILL.md");
const DOCS_SKILL = path.join(repoRoot, "..", "astrivya-docs", "public", "agent-onboarding", "SKILL.md");

/** Tool names from the CORE_TOOL_DEFINITIONS array literal in schemas.ts. */
function collectToolNames(schemasPath) {
  const src = fs.readFileSync(schemasPath, "utf8");
  const start = src.indexOf("CORE_TOOL_DEFINITIONS");
  if (start < 0) throw new Error(`CORE_TOOL_DEFINITIONS not found in ${schemasPath}`);
  const bracket = src.indexOf("[", start);
  const end = src.indexOf("];", bracket);
  if (bracket < 0 || end < 0) throw new Error(`Cannot parse CORE_TOOL_DEFINITIONS array in ${schemasPath}`);
  const body = src.slice(bracket, end);
  return [...body.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

/** Backticked identifiers in the doc's tools-table section (##/### Tools). */
function toolsTableNames(docPath) {
  const text = fs.readFileSync(docPath, "utf8");
  const header = text.match(/^#{2,3} Tools\s*$/m);
  if (!header) return { ok: false, names: [] };
  const rest = text.slice(header.index + header[0].length);
  const next = rest.match(/\n#{2,3} /);
  const section = next ? rest.slice(0, next.index) : rest;
  const names = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*`([a-z_]+)`\s*\|/);
    if (m) names.push(m[1]);
  }
  return { ok: true, names };
}

/** Row count of the doc's resources table (##/### Resources). */
function resourcesRowCount(docPath) {
  const text = fs.readFileSync(docPath, "utf8");
  const header = text.match(/^#{2,3} Resources\s*$/m);
  if (!header) return -1;
  const rest = text.slice(header.index + header[0].length);
  const next = rest.match(/\n#{2,3} /);
  const section = next ? rest.slice(0, next.index) : rest;
  return section.split("\n").filter((l) => /^\|\s*`[a-z_]+:\/\/[^`]+`\s*\|/.test(l)).length;
}

const problems = [];
const okFiles = [];

function requireToolsTable(label, docPath, expected) {
  if (!fs.existsSync(docPath)) {
    problems.push(`${label}: missing file ${docPath}`);
    return;
  }
  const { ok, names } = toolsTableNames(docPath);
  if (!ok) {
    problems.push(`${label}: no tools table found`);
    return;
  }
  const missing = expected.filter((t) => !names.includes(t));
  const extra = names.filter((t) => !expected.includes(t));
  if (missing.length || extra.length) {
    problems.push(
      `${label}: tools table drift (expected ${expected.length}, found ${names.length})` +
        (missing.length ? ` — missing: ${missing.join(", ")}` : "") +
        (extra.length ? ` — unexpected: ${extra.join(", ")}` : ""),
    );
  } else {
    okFiles.push(`${label} (${names.length} tools)`);
  }
}

function requireContains(label, docPath, needle) {
  if (!fs.existsSync(docPath)) {
    problems.push(`${label}: missing file ${docPath}`);
    return;
  }
  const text = fs.readFileSync(docPath, "utf8");
  if (!text.includes(needle)) {
    problems.push(`${label}: expected to contain "${needle}"`);
  } else {
    okFiles.push(`${label} (count string "${needle}")`);
  }
}

function checkResources(label, docPath, expectedCount) {
  if (!fs.existsSync(docPath)) return;
  const n = resourcesRowCount(docPath);
  if (n !== expectedCount) {
    problems.push(`${label}: resources table has ${n} rows, expected ${expectedCount}`);
  } else {
    okFiles.push(`${label} (${n} resources)`);
  }
}

// ── 1. Source of truth ───────────────────────────────────────────────
const tools = collectToolNames(SCHEMAS);
const n = tools.length;
const sorted = [...tools].sort();
console.log(`Source of truth: ${SCHEMAS}`);
console.log(`  ${n} tools: ${sorted.join(", ")}\n`);

// ── 2. In-repo surfaces (always required) ────────────────────────────
requireToolsTable("mcp-server/README.md", README, tools);
requireContains("mcp-server/README.md", README, `Provides ${n} tools`);
requireContains("mcp-server/package.json", MCP_PKG, `${n} tools for AI coding agents`);
checkResources("mcp-server/README.md", README, 4);

// ── 3. SKILL copies (checked when the sibling workspace is present) ──
for (const [label, p] of [
  [".opencode skill SKILL.md", OPENCODE_SKILL],
  ["astrivya-docs SKILL.md", DOCS_SKILL],
]) {
  if (!fs.existsSync(p)) {
    console.log(`[skip] ${label}: not present in this workspace (${p})`);
    continue;
  }
  requireToolsTable(label, p, tools);
  requireContains(label, p, `${n} tools + 4 resources`);
  requireContains(label, p, `(${n} tools, 4 resources`);
  checkResources(label, p, 4);
}

// ── Report ───────────────────────────────────────────────────────────
console.log("Checks:");
for (const f of okFiles) console.log(`  \u2713 ${f}`);
if (problems.length) {
  for (const p of problems) console.log(`  \u2717 ${p}`);
  console.error(
    `\nDrift detected: ${problems.length} problem(s). Fix the docs listed above — the ` +
      `tool surface must match CORE_TOOL_DEFINITIONS in schemas.ts exactly.`,
  );
  process.exit(1);
}
console.log(`\nOK \u2014 ${n}-tool surface documented consistently across ${okFiles.length} surface(s).`);
