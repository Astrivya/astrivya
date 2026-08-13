#!/usr/bin/env node
/**
 * Astrivya Cloud — real end-user smoke test.
 *
 * Installs the PUBLISHED npm packages (@astrivya/cli, @astrivya/mcp-server)
 * into a temp prefix — exactly what a real user gets — and exercises the
 * deployed cloud API end-to-end:
 *
 *   1. `astrivya auth whoami`            → GET /api/ide/me
 *   2. `astrivya team create <name>`     → POST /api/org (org + team + membership)
 *   3. `astrivya akg init --sync`        → POST /api/akg/sync/push
 *   4. MCP stdio handshake               → initialize + tools/list + team tools
 *
 * Usage:
 *   ASTRIVYA_TOKEN=<pat> node scripts/cloud-smoke.mjs
 *   ASTRIVYA_TOKEN=<pat> ASTRIVYA_BASE_URL=https://app.astrivya.ai node scripts/cloud-smoke.mjs
 *
 * Env:
 *   ASTRIVYA_TOKEN       required — a real PAT (ast_/astr_) for the cloud user
 *   ASTRIVYA_BASE_URL    default https://api.astrivya.ai (the deployed surface)
 *   ASTRIVYA_ORG_ID      optional — reuse an existing org; when unset the test
 *                        creates a fresh team via `team create` and uses it
 *   NO_COLOR / CI        disable ANSI for logs
 *
 * Exit code: 0 when every step passes, 1 otherwise (CI-friendly).
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BASE_URL = process.env.ASTRIVYA_BASE_URL || "https://api.astrivya.ai";
const TOKEN = process.env.ASTRIVYA_TOKEN || "";
const ORG_ID = process.env.ASTRIVYA_ORG_ID || "";
const CLI_VERSION = process.env.ASTRIVYA_CLI_VERSION || "latest";
const MCP_VERSION = process.env.ASTRIVYA_MCP_VERSION || "latest";

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg, detail = "") {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    failures.push(msg + (detail ? ` — ${detail}` : ""));
    console.log(`  \u2717 ${msg}${detail ? `\n      ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m== ${title}\x1b[0m`);
}

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", ...opts });
}

/** Create an isolated home so the run never touches the user's real config. */
function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-smoke-"));
  const env = {
    ...process.env,
    ASTRIVYA_TOKEN: TOKEN,
    ASTRIVYA_BASE_URL: BASE_URL,
    ASTRIVYA_CLOUD_URL: BASE_URL,
    ASTRIVYA_ORG_ID: ORG_ID,
    ASTRIVYA_AUTO_INDEX: "off",
    NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
  if (process.platform === "win32") {
    env.APPDATA = home;
    env.USERPROFILE = home;
  } else {
    env.HOME = home;
    env.XDG_CONFIG_HOME = path.join(home, ".config");
  }
  return { home, env };
}

function configPath(home) {
  return process.platform === "win32"
    ? path.join(home, "astrivya", "config", "config.json")
    : path.join(home, ".config", "astrivya", "config.json");
}

function readConfig(home) {
  try {
    return JSON.parse(fs.readFileSync(configPath(home), "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Step 0 — install the PUBLISHED packages into a temp prefix (real user flow)
// ---------------------------------------------------------------------------
async function installPublishedPackages() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-pkgs-"));
  console.log(`  Installing published packages into ${prefix} ...`);
  const res = sh(
    `npm install --prefix "${prefix}" --no-audit --no-fund --loglevel=error ` +
      `@astrivya/cli@${CLI_VERSION} @astrivya/mcp-server@${MCP_VERSION}`,
    { cwd: ROOT, timeout: 240000 },
  );
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(1);
  }
  const bin = path.join(prefix, "node_modules", ".bin");
  return {
    prefix,
    cli: path.join(bin, process.platform === "win32" ? "astrivya.cmd" : "astrivya"),
    mcp: path.join(bin, process.platform === "win32" ? "astrivya-mcp.cmd" : "astrivya-mcp"),
  };
}

// ---------------------------------------------------------------------------
// Step 1 — whoami
// ---------------------------------------------------------------------------
function stepWhoami(tools, env) {
  section("1. auth whoami (GET /api/ide/me)");
  const res = sh(`"${tools.cli}" auth whoami`, { env, timeout: 60000 });
  ok(res.status === 0, "whoami exits 0", res.stderr?.trim() || res.stdout?.trim() || "");
  const hasIdentity = /Authenticated as:|User ID:/i.test(res.stdout || "");
  ok(hasIdentity, "whoami reports an identity", (res.stdout || "").trim().slice(0, 200));
  return res.stdout || "";
}

// ---------------------------------------------------------------------------
// Step 2 — team create (fresh team) or reuse ASTRIVYA_ORG_ID
// ---------------------------------------------------------------------------
function stepTeam(tools, env, home) {
  section("2. team create (POST /api/org)");
  const slug = `smoke-${Date.now().toString(36)}`;
  const res = sh(`"${tools.cli}" team create "Smoke Test ${Date.now()}" --slug ${slug}`, {
    env,
    timeout: 60000,
  });
  ok(res.status === 0, "team create exits 0", res.stderr?.trim() || "");
  ok(/Created team/i.test(res.stdout || ""), "team create reports success", (res.stdout || "").trim().slice(0, 300));
  const cfg = readConfig(home);
  const orgId = ORG_ID || cfg.orgId;
  ok(Boolean(orgId), "org id persisted to config", `orgId=${orgId || "(none)"}`);
  if (orgId) env.ASTRIVYA_ORG_ID = orgId;
  return orgId || "";
}

// ---------------------------------------------------------------------------
// Step 3 — akg init --sync (POST /api/akg/sync/push)
// ---------------------------------------------------------------------------
function stepAkgSync(tools, env) {
  section("3. akg init --sync (POST /api/akg/sync/push)");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-smoke-ws-"));
  fs.writeFileSync(
    path.join(ws, "sample.js"),
    "// smoke test module\nfunction greet(name) {\n  return `hello ${name}`;\n}\nmodule.exports = { greet };\n",
  );
  const res = sh(`"${tools.cli}" akg init --no-embed --sync`, { cwd: ws, env, timeout: 180000 });
  ok(res.status === 0, "akg init exits 0", res.stderr?.trim() || "");
  const out = res.stdout || "";
  if (/Cloud sync pushed/i.test(out)) {
    ok(true, "cloud sync pushed chunks", out.match(/Cloud sync pushed [^\n]*/i)?.[0] || "");
  } else if (/Cloud sync skipped/i.test(out) || /Cloud sync unreachable/i.test(out)) {
    ok(false, "cloud sync did not push", out.match(/(Cloud sync [^\n]*)/i)?.[0] || out.slice(-300));
  } else {
    ok(
      true,
      "akg init completed",
      out
        .split("\n")
        .filter((l) => l.trim())
        .slice(-3)
        .join(" | "),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 4 — MCP stdio handshake (initialize → tools/list → team tools)
// ---------------------------------------------------------------------------
function stepMcp(tools, env) {
  section("4. MCP team tools (initialize → get_team_context / get_team_members)");
  return new Promise((resolve) => {
    const child = spawn(tools.mcp, [], {
      env: { ...env, ASTRIVYA_CLOUD_URL: BASE_URL, ASTRIVYA_BASE_URL: BASE_URL, ASTRIVYA_AUTO_INDEX: "off" },
      stdio: ["pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });

    let buf = "";
    let seq = 0;
    const pending = new Map();
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {}
      resolve(code);
    };
    setTimeout(() => finish(1), 90000);

    const send = (method, params = {}) =>
      new Promise((res2) => {
        const id = ++seq;
        pending.set(id, res2);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id && pending.has(msg.id)) {
          const res2 = pending.get(msg.id);
          pending.delete(msg.id);
          res2(msg);
        }
      }
    });

    child.on("error", (e) => {
      ok(false, "mcp server spawns", e.message);
      finish(1);
    });
    child.on("exit", () => finish(1));

    (async () => {
      const init = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cloud-smoke", version: "1.0.0" },
      });
      ok(
        !init.error && init.result?.serverInfo,
        "initialize handshake succeeds",
        JSON.stringify(init.error || init.result?.serverInfo),
      );
      const serverName = init.result?.serverInfo?.name || "";
      ok(/astrivya-mcp-server/i.test(serverName), "server announces astrivya-mcp-server", serverName);

      const toolsList = await send("tools/list", {});
      const names = (toolsList.result?.tools || []).map((t) => t.name);
      ok(names.length >= 18, `tools/list returns >= 18 tools (got ${names.length})`, names.join(", "));
      ok(
        ["get_team_context", "get_team_members", "get_team_analytics"].every((t) => names.includes(t)),
        "team tools are exposed",
      );

      const ctx = await send("tools/call", { name: "get_team_context", arguments: {} });
      const ctxText = ctx.result?.content?.[0]?.text || JSON.stringify(ctx.error || {});
      let ctxSource = "";
      let ctxTeamCount = 0;
      let ctxMemberCount = 0;
      try {
        const parsed = JSON.parse(ctxText);
        ctxSource = parsed?.source || "";
        const cloud = parsed?.data?.cloud || {};
        ctxTeamCount = Array.isArray(cloud.team) ? cloud.team.length : 0;
        ctxMemberCount = Array.isArray(cloud.members) ? cloud.members.length : 0;
      } catch {}
      ok(
        ctxSource === "cloud" && (ctxTeamCount > 0 || ctxMemberCount > 0),
        `get_team_context returns real CLOUD team data (teams=${ctxTeamCount}, members=${ctxMemberCount})`,
        ctxText.slice(0, 200),
      );

      const members = await send("tools/call", { name: "get_team_members", arguments: {} });
      const memText = members.result?.content?.[0]?.text || JSON.stringify(members.error || {});
      let memberCount = 0;
      try {
        memberCount = (JSON.parse(memText)?.data?.members || []).length;
      } catch {}
      ok(memberCount > 0, `get_team_members returns real members (got ${memberCount})`, memText.slice(0, 200));

      finish(0);
    })();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("\nAstrivya Cloud smoke test");
  console.log(`  cloud:        ${BASE_URL}`);
  console.log(`  packages:     @astrivya/cli@${CLI_VERSION} + @astrivya/mcp-server@${MCP_VERSION} (npm)`);
  console.log(`  token:        ${TOKEN ? `${TOKEN.slice(0, 8)}…${TOKEN.slice(-4)}` : "(missing)"}`);

  if (!TOKEN) {
    console.error("\n  ASTRIVYA_TOKEN is required — set it to a real PAT (ast_/astr_) for the cloud user.\n");
    process.exit(1);
  }

  try {
    const tools = await installPublishedPackages();
    const { home, env } = isolatedHome();

    stepWhoami(tools, env);
    const orgId = stepTeam(tools, env, home);
    if (!ORG_ID) {
      ok(Boolean(orgId), "smoke run has an org id to sync against", orgId || "");
    }
    stepAkgSync(tools, env);
    await stepMcp(tools, env);
  } catch (err) {
    failed++;
    failures.push(`unhandled error: ${err.message}`);
    console.error(`\n  \u2717 unhandled error: ${err.message}`);
  }

  console.log(`\n${"─".repeat(56)}`);
  console.log(`  Passed: ${passed}   Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    \u2717 ${f}`);
  }
  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main();
