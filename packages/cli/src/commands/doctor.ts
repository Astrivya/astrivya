import type { Command } from "commander";
import { apiCall, getBaseUrl, getToken, loadConfig } from "../lib/compat";
import { json as printJson } from "../lib/output";
import { ALL_TOOLS, buildMcpServiceEntry, buildOpenCodeEntry } from "./setup";

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
    .action(async (options) => {
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
            status: "fail",
            detail: "Token rejected by server. Run `astrivya auth login`.",
          });
        }
      } else {
        authChecks.push({
          label: "Authenticated",
          status: "fail",
          detail: "No token found. Run `astrivya auth login`.",
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
            status: "fail",
            detail: `${baseUrl} (HTTP ${res.status})`,
          });
        }
      } catch {
        backendChecks.push({
          label: "API reachable",
          status: "fail",
          detail: `Cannot connect to ${baseUrl}`,
        });
      }
      if (backendChecks.length > 0) sections.push({ title: "Backend", checks: backendChecks });

      // ── MCP Server ──────────────────────────────────────
      const mcpChecks: Check[] = [];
      try {
        const pkgVersion = process.env.__PACKAGE_VERSION__ || "0.0.0";
        mcpChecks.push({ label: `@astrivya/cli v${pkgVersion}`, status: "pass" });
      } catch {
        mcpChecks.push({ label: "Package version", status: "warn", detail: "Could not detect" });
      }

      // Check embeddings
      try {
        await apiCall("/api/memories/search", "POST", {
          query: "health check test query",
          limit: 1,
        });
        mcpChecks.push({ label: "Search working", status: "pass" });
      } catch {
        mcpChecks.push({
          label: "Search working",
          status: "fail",
          detail: "Memory search returned an error",
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
                mcpSection.astrivya = buildOpenCodeEntry(apiUrl);
                (cfg as any).mcp = mcpSection;
              } else {
                const servers = (cfg as any).mcpServers || {};
                servers.astrivya = buildMcpServiceEntry(apiUrl);
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
