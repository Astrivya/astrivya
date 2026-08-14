import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import type { Command } from "commander";
import { apiCall, getBaseUrl, getToken, loadConfig } from "../lib/compat";
import { getConfigPath } from "../lib/config";
import { color, getErrorMessage, json as printJson } from "../lib/output";
import { CURRENT_VERSION } from "../lib/version";
import { summarizeMcpJournal } from "./mcp";
import { ALL_TOOLS, buildMcpServiceEntry, buildOpenCodeEntry } from "./setup";

export interface McpSelfTestResult {
  ok: boolean;
  serverName?: string;
  serverVersion?: string;
  tools: string[];
  error?: string;
}

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
    tools?: Array<{ name: string }>;
  };
  error?: { message?: string };
}

/**
 * Spawn the real MCP server (via the CLI's own `mcp-server` subcommand — the
 * verified launcher identity) and complete a JSON-RPC initialize handshake +
 * tools/list over stdio. Uses its own timer (macOS has no `timeout` binary).
 * Auto-index and update checks are disabled so the self-test is fast and
 * side-effect free.
 */
// 45s default: the npx fallback can cold-fetch the package on first run
// (~100+ deps), which exceeds 20s; a warm start resolves in ~1s.
export function runMcpSelfTest(timeoutMs = 45_000): Promise<McpSelfTestResult> {
  return new Promise((resolve) => {
    const cliEntry = process.argv[1] || "astrivya";
    // Prefer re-executing ourselves when the entry is a JS file (node dist/index.js).
    // When the CLI is launched through a shell shim, node can't re-run it — fall
    // back to the published package, which is also exactly what the generated
    // client configs execute.
    const isJsEntry = /\.(c?m?js)$/.test(cliEntry);
    const cmd = isJsEntry ? process.execPath : process.platform === "win32" ? "npx.cmd" : "npx";
    const args = isJsEntry ? [cliEntry, "mcp-server"] : ["-y", "@astrivya/mcp-server"];
    // On Windows, .cmd/.bat shims can't be spawned directly — shell: true is
    // required or npx.cmd fails with EINVAL/ENOENT. Args are constants, so we
    // join them into a command string for the shell case (avoids DEP0190 and
    // keeps stderr clean).
    const useShell = !isJsEntry && process.platform === "win32";
    let child: ReturnType<typeof spawn>;
    try {
      if (useShell) {
        child = spawn(`${cmd} ${args.map((a) => `\"${a}\"`).join(" ")}`, {
          cwd: process.cwd(),
          env: { ...process.env, ASTRIVYA_AUTO_INDEX: "off", NO_UPDATE_NOTIFIER: "1" },
          stdio: ["pipe", "pipe", "inherit"],
          shell: true,
        });
      } else {
        child = spawn(cmd, args, {
          cwd: process.cwd(),
          env: { ...process.env, ASTRIVYA_AUTO_INDEX: "off", NO_UPDATE_NOTIFIER: "1" },
          stdio: ["pipe", "pipe", "inherit"],
        });
      }
    } catch (err: unknown) {
      resolve({ ok: false, tools: [], error: `Could not spawn MCP server: ${getErrorMessage(err)}` });
      return;
    }

    // Swallow EPIPE — if the server dies before we write, an unhandled stream
    // error would crash the parent doctor process.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});

    let stdoutBuf = "";
    let settled = false;
    let initialized = false;
    let serverName: string | undefined;
    let serverVersion: string | undefined;

    const finish = (result: McpSelfTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, tools: [], error: "MCP server handshake timed out" });
    }, timeoutMs);

    child.on("error", (err) => {
      finish({ ok: false, tools: [], error: `MCP server failed to start: ${err.message}` });
    });

    child.on("exit", (code) => {
      if (!settled) {
        finish({
          ok: false,
          tools: [],
          error: `MCP server exited early (code ${code}) before completing the handshake`,
        });
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          serverName = msg.result.serverInfo?.name || "astrivya-mcp-server";
          serverVersion = msg.result.serverInfo?.version;
          initialized = true;
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
        } else if (msg.id === 2 && msg.result?.tools) {
          const tools = msg.result.tools.map((t) => t.name).sort();
          finish({ ok: true, serverName, serverVersion, tools });
        } else if (msg.error && !initialized) {
          finish({ ok: false, tools: [], error: msg.error.message || "initialize rejected" });
        }
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "astrivya-doctor", version: CURRENT_VERSION },
        },
      })}\n`,
    );
  });
}

interface Check {
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail?: string;
}

function printSection(title: string, checks: Check[]): number {
  if (checks.length === 0) return 0;
  console.log(`\n  ${title}`);
  console.log(`  ${"─".repeat(title.length + 2)}`);
  let passed = 0;
  for (const c of checks) {
    const icon = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : c.status === "warn" ? "⚠" : "○";
    console.log(`  ${icon} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    if (c.status === "pass") passed++;
  }
  return passed;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Run health checks on your Astrivya setup")
    .option("--fix", "Attempt to fix issues automatically")
    .option("--json", "Output raw JSON")
    .option("--mcp", "Run only the MCP server self-test (spawn + initialize + tools/list)")
    .action(async (options) => {
      // Dedicated self-test: spawn the real server and list its tools.
      if (options.mcp) {
        console.log("\n  Astrivya MCP Self-Test");
        console.log(`  ${"═".repeat(30)}`);
        const result = await runMcpSelfTest();
        if (result.ok) {
          console.log(
            `  \u2713 MCP server boots: ${result.serverName}${result.serverVersion ? ` v${result.serverVersion}` : ""}`,
          );
          console.log("  \u2713 initialize handshake OK");
          console.log(`  \u2713 ${result.tools.length} tools served:`);
          for (const t of result.tools) console.log(`      - ${t}`);
          console.log();
          process.exit(0);
        }
        console.log(`  \u2717 ${result.error || "MCP server self-test failed"}`);
        console.log(`  Run ${color.cyan("`astrivya mcp-server`")} manually to see server output.\n`);
        process.exitCode = 1;
        return;
      }

      const sections: Array<{ title: string; checks: Check[] }> = [];

      if (!options.json) {
        console.log("\n  Astrivya Health Check");
        console.log(`  ${"═".repeat(30)}`);
      }

      // ── Authentication ──────────────────────────────────
      const authChecks: Check[] = [];
      const token = getToken();
      if (token) {
        authChecks.push({ label: "Token present", status: "pass" });
        try {
          const profile = await apiCall("/api/ide/me", "GET");
          const email = profile.email || "unknown";
          authChecks.push({ label: "Authenticated", status: "pass", detail: email });
        } catch {
          authChecks.push({
            label: "Token valid",
            status: "warn",
            detail: "Cloud unavailable — local mode works. Run `astrivya auth login` to enable cloud.",
          });
        }
      } else {
        authChecks.push({
          label: "Authenticated",
          status: "warn",
          detail: "No token found — local mode works. Run `astrivya auth login` for cloud features.",
        });
      }
      if (authChecks.length > 0) sections.push({ title: "Authentication", checks: authChecks });

      // ── Backend ─────────────────────────────────────────
      const backendChecks: Check[] = [];
      const baseUrl = getBaseUrl();
      const start = Date.now();
      try {
        const res = await fetch(`${baseUrl}/api/ide/me`, {
          method: "GET",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const ms = Date.now() - start;
          backendChecks.push({
            label: "API reachable",
            status: "pass",
            detail: `${baseUrl} (${ms}ms)`,
          });
        } else {
          backendChecks.push({
            label: "API reachable",
            status: "warn",
            detail: `Cloud API unreachable at ${baseUrl} — local features unaffected`,
          });
        }
      } catch {
        backendChecks.push({
          label: "API reachable",
          status: "warn",
          detail: `Cannot connect to ${baseUrl} — local features unaffected`,
        });
      }
      if (backendChecks.length > 0) sections.push({ title: "Backend", checks: backendChecks });

      // ── MCP Server ──────────────────────────────────────
      const mcpChecks: Check[] = [];
      // Real boot check: spawn the server and complete the handshake. This is
      // what catches a broken launcher config — the old check was a hardcoded
      // unconditional pass that never started the server.
      const selfTest = await runMcpSelfTest();
      if (selfTest.ok) {
        mcpChecks.push({
          label: "MCP server boots + handshake",
          status: "pass",
          detail: `${selfTest.serverName || "astrivya-mcp-server"}${selfTest.serverVersion ? ` v${selfTest.serverVersion}` : ""}, ${selfTest.tools.length} tools served`,
        });
      } else {
        mcpChecks.push({
          label: "MCP server boots + handshake",
          status: "fail",
          detail: selfTest.error || "could not complete initialize handshake",
        });
      }

      // Check the local knowledge graph (the real backing of local search)
      let localNodes = 0;
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const stats = storage.getStats();
        localNodes = stats.nodes;
        if (localNodes > 0) {
          // Staleness: warn when the newest node is older than 30 days.
          const row = storage.runQuery("SELECT MAX(updated_at) AS m FROM nodes")[0] as
            | { m?: number | null }
            | undefined;
          const newest = typeof row?.m === "number" ? row.m : null;
          const stale = newest !== null && Date.now() - newest > 30 * 24 * 60 * 60 * 1000;
          mcpChecks.push({
            label: "Local knowledge graph",
            status: stale ? "warn" : "pass",
            detail: stale
              ? `${localNodes} nodes indexed, but the graph is stale (30+ days) — run \`astrivya akg reindex\``
              : `${localNodes} nodes indexed`,
          });
        } else {
          mcpChecks.push({
            label: "Local knowledge graph",
            status: "warn",
            detail: "Not indexed yet — run `astrivya akg init` (or start the MCP server to auto-index)",
          });
        }
      } catch {
        mcpChecks.push({ label: "Local knowledge graph", status: "warn", detail: "Could not open akg.db" });
      }

      // Check the MCP session journal (written by the mcp-server)
      const mcpSummary = summarizeMcpJournal(process.cwd());
      if (mcpSummary.hasJournal) {
        mcpChecks.push({
          label: "MCP session journal",
          status: "pass",
          detail: `${mcpSummary.sessions} session(s), ${mcpSummary.toolCalls} tool call(s)`,
        });
      } else {
        mcpChecks.push({
          label: "MCP session journal",
          status: "warn",
          detail: "No MCP activity recorded yet — run an agent configured with Astrivya MCP",
        });
      }
      if (mcpChecks.length > 0) sections.push({ title: "MCP Server", checks: mcpChecks });

      // ── Tools ───────────────────────────────────────────
      const toolChecks: Check[] = [];
      const apiUrl = getBaseUrl();
      for (const tool of ALL_TOOLS) {
        const detected = tool.detect();
        if (!detected) {
          toolChecks.push({ label: tool.name, status: "skip", detail: "Not detected" });
          continue;
        }
        try {
          const existing = tool.readConfig();
          let hasAstrivya = false;
          if (tool.name === "OpenCode") {
            hasAstrivya = !!(existing as any).mcp?.astrivya;
          } else {
            hasAstrivya = !!(existing as any).mcpServers?.astrivya;
          }
          if (hasAstrivya) {
            toolChecks.push({ label: tool.name, status: "pass", detail: "Configured" });
          } else {
            const fixLabel = options.fix ? "Fixed" : "Missing config";
            toolChecks.push({
              label: tool.name,
              status: options.fix ? "pass" : "fail",
              detail: fixLabel,
            });
            if (options.fix) {
              const cfg = tool.readConfig();
              if (tool.name === "OpenCode") {
                const mcpSection = (cfg as any).mcp || {};
                mcpSection.astrivya = buildOpenCodeEntry(apiUrl, undefined, undefined, token);
                (cfg as any).mcp = mcpSection;
              } else {
                const servers = (cfg as any).mcpServers || {};
                servers.astrivya = buildMcpServiceEntry(apiUrl, undefined, undefined, token);
                (cfg as any).mcpServers = servers;
              }
              tool.writeConfig(cfg);
            }
          }
        } catch {
          toolChecks.push({ label: tool.name, status: "warn", detail: "Could not read config" });
        }
      }
      if (toolChecks.length > 0) sections.push({ title: "Tools", checks: toolChecks });

      // ── Config ──────────────────────────────────────────
      const configChecks: Check[] = [];
      const config = loadConfig();
      if (config.token) configChecks.push({ label: "Config file present", status: "pass" });
      else
        configChecks.push({
          label: "Config file",
          status: "warn",
          detail: "No token stored locally",
        });
      if (config.baseUrl) configChecks.push({ label: "Base URL", status: "pass", detail: config.baseUrl });
      if (config.teamId) configChecks.push({ label: "Default team", status: "pass", detail: config.teamId });

      // Single source of truth: surface the resolved config path and flag any
      // stray duplicate (e.g. an older tool writing to `...\astrivya\config.json`
      // while env-paths resolves config to `...\astrivya\Config\config.json`).
      const resolvedPath = getConfigPath("config.json");
      configChecks.push({ label: "Config file path", status: "pass", detail: resolvedPath });
      const strayPath = path.join(path.dirname(resolvedPath), "..", "config.json");
      if (fs.existsSync(strayPath)) {
        configChecks.push({
          label: "Stray config file",
          status: "warn",
          detail: `${strayPath} exists — values there are ignored; the file above is authoritative`,
        });
      }

      // BYOK provider check
      const openaiKey = process.env.ASTRIVYA_OPENAI_KEY;
      const anthropicKey = process.env.ASTRIVYA_ANTHROPIC_KEY;
      if (openaiKey || anthropicKey) {
        const provider = openaiKey ? "OpenAI" : "Anthropic";
        configChecks.push({
          label: "BYOK provider",
          status: "pass",
          detail: provider,
        });
      }

      if (configChecks.length > 0) sections.push({ title: "Configuration", checks: configChecks });

      // ── Print Results ───────────────────────────────────
      let totalPassed = 0;
      let totalChecks = 0;
      for (const section of sections) {
        let passed = 0;
        if (!options.json) {
          passed = printSection(section.title, section.checks);
        } else {
          passed = section.checks.filter((c) => c.status === "pass").length;
        }
        totalPassed += passed;
        totalChecks += section.checks.length;
      }

      const failed = totalChecks - totalPassed;
      if (!options.json) {
        console.log(`\n  ${"═".repeat(30)}`);
        if (failed === 0) {
          console.log(`  All ${totalChecks} checks passed.\n`);
        } else {
          console.log(`  ${totalPassed}/${totalChecks} passed. ${failed} issue(s) found.`);
          if (!options.fix) {
            console.log("  Run `astrivya doctor --fix` to auto-configure missing tools.\n");
          } else {
            console.log("  Auto-fix applied to tool configs. Run doctor again to verify.\n");
          }
        }
      }

      if (options.json) {
        printJson({ timestamp: new Date().toISOString(), sections });
      }
    });
}
