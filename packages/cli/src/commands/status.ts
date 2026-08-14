import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import type { Command } from "commander";
import { apiCall, getBaseUrl, getToken, loadConfig } from "../lib/compat";
import { getConfigPath } from "../lib/config";
import {
  color,
  divider,
  getErrorMessage,
  header,
  info,
  json as printJson,
  startSpinner,
  subheader,
} from "../lib/output";
import { summarizeMcpJournal } from "./mcp";

async function getLocalAkgStats(): Promise<{ nodes: number } | null> {
  try {
    const storage = new AkgStorage();
    await storage.init(process.cwd());
    const s = storage.getStats();
    return s.nodes > 0 ? { nodes: s.nodes } : null;
  } catch {
    return null;
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Quick overview of your Astrivya status — org, auth, pending items")
    .option("--json", "Output raw JSON")
    .option("--ndjson", "Output newline-delimited JSON")
    .action(async (options) => {
      let spinner: any = null;
      try {
        spinner = startSpinner("Gathering status...");

        const token = getToken();
        const config = loadConfig();

        let profile: any = null;
        let orgData: any = null;
        let briefings: any[] = [];
        let recentDecisions: any[] = [];
        let creditBalance: any = null;

        if (token) {
          try {
            profile = await apiCall("/api/ide/me", "GET");
          } catch {
            // auth may be expired
          }

          try {
            orgData = await apiCall("/api/org", "GET");
          } catch {
            // org access may be limited
          }

          try {
            const briefingResult = await apiCall("/api/briefing/daily?limit=1", "GET");
            briefings = briefingResult.briefings || [];
          } catch {
            // briefings may not be available
          }

          try {
            const decisionsResult = await apiCall("/api/decisions?limit=5", "GET");
            recentDecisions = decisionsResult.decisions || [];
          } catch {
            // decisions may not be available
          }

          try {
            creditBalance = await apiCall("/api/credits/balance", "GET");
          } catch {
            // credits may not be available
          }
        }

        spinner.stop();

        const mcpSummary = summarizeMcpJournal(process.cwd());

        if (options.ndjson) {
          console.log(JSON.stringify({ type: "auth", authenticated: !!token, profile }));
          console.log(
            JSON.stringify({
              type: "config",
              baseUrl: config.baseUrl,
              teamId: config.teamId,
              hasToken: !!config.token,
            }),
          );
          console.log(
            JSON.stringify({
              type: "localAi",
              profile: config.localAiProfile || null,
              offlineMode: !!config.offlineMode,
              ollamaUrl: config.ollamaUrl || null,
            }),
          );
          console.log(JSON.stringify({ type: "organization", ...orgData }));
          console.log(JSON.stringify({ type: "credits", ...creditBalance }));
          console.log(JSON.stringify({ type: "mcp", ...mcpSummary }));
          for (const b of briefings) {
            console.log(JSON.stringify({ type: "briefing", ...b }));
          }
          for (const d of recentDecisions) {
            console.log(JSON.stringify({ type: "decision", ...d }));
          }
          return;
        }

        if (options.json) {
          printJson({
            authenticated: !!token,
            profile,
            config: {
              baseUrl: config.baseUrl,
              teamId: config.teamId,
              hasToken: !!config.token,
            },
            localAi: {
              profile: config.localAiProfile || null,
              offlineMode: !!config.offlineMode,
              ollamaUrl: config.ollamaUrl || null,
            },
            mcp: mcpSummary,
            organization: orgData,
            credits: creditBalance,
            recentBriefings: briefings,
            recentDecisions,
          });
          return;
        }

        header("Astrivya Status");

        // Authentication
        subheader("Authentication");
        if (profile) {
          const email = profile.email || "unknown";
          const name = profile.full_name || profile.name || "";
          console.log(`  ${color.green("\u2713")} Authenticated${name ? ` as ${color.bold(name)}` : ""}`);
          console.log(`  Email: ${color.dim(email)}`);
          if (profile.id) console.log(`  User ID: ${color.dim(profile.id)}`);
        } else if (token) {
          info("Token found but profile unavailable (may be expired)");
        } else {
          console.log(`  ${color.yellow("\u26A0")} Not authenticated`);
          console.log(`  Run ${color.cyan("astrivya auth login")} to authenticate.`);
          const stats = await getLocalAkgStats();
          if (stats && stats.nodes > 0) {
            console.log(
              `  ${color.dim("Your local AKG has")} ${color.cyan(String(stats.nodes))} ${color.dim("nodes —")} ${color.cyan("sync them with your team")} ${color.dim("for context-aware collaboration.")}`,
            );
            console.log(`  ${color.dim("→ Sign up:")} ${color.cyan("https://astrivya.ai")}`);
          }
        }
        console.log();

        // Organization
        subheader("Organization");
        if (orgData?.organization) {
          const org = orgData.organization;
          const stats = orgData.stats || {};
          console.log(`  ${color.bold(org.name || org.org_name || "My Organization")}`);
          if (config.teamId) console.log(`  Team ID: ${color.dim(config.teamId)}`);
          if (stats.teams_count !== undefined) console.log(`  Teams: ${stats.teams_count}`);
          if (stats.members_count !== undefined) console.log(`  Members: ${stats.members_count}`);
          if (stats.memories_count !== undefined) console.log(`  Memories: ${stats.memories_count}`);
          if (stats.decisions_count !== undefined) console.log(`  Decisions: ${stats.decisions_count}`);
        } else if (config.teamId) {
          console.log(`  Team ID: ${color.dim(config.teamId)}`);
        } else {
          console.log(`  ${color.dim("No organization configured.")}`);
          console.log(`  Run ${color.cyan("astrivya setup")} or create an org on the dashboard.`);
        }
        console.log();

        // Connection
        subheader("Connection");
        console.log(`  API:          ${color.dim(getBaseUrl())}`);
        console.log(`  Config:       ${color.dim(getConfigPath("config.json"))}`);
        console.log();

        // Credits
        if (creditBalance) {
          subheader("Credits");
          const bal = Number(creditBalance.balance ?? 0);
          const consumed = Number(creditBalance.lifetime_consumed ?? 0);
          const purchased = Number(creditBalance.lifetime_purchased ?? 0);
          const pctColor = bal <= 10 ? color.red : bal <= 50 ? color.yellow : color.green;
          console.log(`  Balance:      ${pctColor(`${bal} credits`)}${bal <= 10 ? color.yellow(" \u26A0 Low") : ""}`);
          if (consumed > 0) console.log(`  Used:         ${consumed} credits lifetime`);
          if (purchased > 0) console.log(`  Purchased:    ${purchased} credits lifetime`);
          if (creditBalance.last_monthly_refill_at) {
            console.log(
              `  Refill:       ${color.dim(new Date(creditBalance.last_monthly_refill_at).toLocaleDateString())}`,
            );
          }
          console.log(`  ${color.dim("Details:")} ${color.cyan("astrivya credits")}`);
          console.log();
        }

        // Local AI
        subheader("Local AI");
        if (config.localAiProfile) {
          const profileName = config.localAiProfile === "smart" ? "Smart" : "Lite";
          console.log(`  Profile:      ${color.green(profileName)}`);
          console.log(
            `  Offline Mode: ${config.offlineMode ? color.yellow("Enabled (100% offline)") : color.dim("Disabled (smart routing active)")}`,
          );
          console.log(`  Local Context: ${color.dim("Using local knowledge index")}`);
        } else {
          console.log(`  Status:       ${color.dim("Not configured")}`);
          console.log(`  Run ${color.cyan("astrivya local setup")} to enable local AI.`);
        }
        console.log();

        // MCP Server
        subheader("MCP Server");
        if (mcpSummary.hasJournal) {
          console.log(`  Sessions:     ${color.bold(`${mcpSummary.activeSessions} active / ${mcpSummary.sessions} total`)}`);
          console.log(
            `  Tool calls:   ${color.bold(String(mcpSummary.toolCalls))}${mcpSummary.toolErrors > 0 ? color.yellow(` (${mcpSummary.toolErrors} errors)`) : ""}`,
          );
          if (mcpSummary.lastActivity) {
            console.log(`  Last activity: ${color.dim(new Date(mcpSummary.lastActivity).toLocaleString())}`);
          }
          console.log(`  ${color.dim("Details:")} ${color.cyan("astrivya mcp")}`);
        } else {
          console.log(`  ${color.dim("No activity journaled in this workspace yet.")}`);
          console.log(`  Run ${color.cyan("astrivya setup --detect")} to configure agents.`);
        }
        console.log();

        // Recent Activity
        if (briefings.length > 0 || recentDecisions.length > 0) {
          subheader("Recent Activity");

          if (briefings.length > 0) {
            const latest = briefings[0];
            const date = latest.created_at
              ? new Date(latest.created_at).toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })
              : "";
            const snippet = (latest.summary || latest.ai_summary || "").slice(0, 120).replace(/\n/g, " ");
            console.log(`  ${color.cyan("\uD83D\uDCD0")} Latest Briefing ${color.dim(date)}`);
            if (snippet) console.log(`  ${snippet}`);
            console.log();
          }

          if (recentDecisions.length > 0) {
            console.log(`  ${color.cyan("\uD83D\uDCCB")} Recent Decisions (${recentDecisions.length})`);
            for (const d of recentDecisions.slice(0, 3)) {
              const title = d.title || "Untitled";
              const date = d.created_at
                ? new Date(d.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                : "";
              console.log(`    ${color.bold(title)} ${color.dim(date)}`);
            }
            console.log();
          }
        }

        divider();
        console.log(`  ${color.dim("Run `astrivya doctor` for a full health check")}`);
        console.log(`  ${color.dim("Run `astrivya update check` to check for CLI updates")}\n`);
      } catch (err: unknown) {
        if (spinner) {
          spinner.stop();
        }
        console.error(`${color.red("\u2717")} Status failed:`, getErrorMessage(err));
        process.exitCode = 1;
        return;
      }
    });
}
