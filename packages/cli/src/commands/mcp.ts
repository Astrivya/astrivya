import { journalPath, readJournal } from "@astrivya/mcp-server";
import type { Command } from "commander";
import { getBaseUrl } from "../lib/compat";
import { color, getErrorMessage, json as printJson } from "../lib/output";
import { ALL_TOOLS, type ToolDetector, buildMcpServiceEntry, buildOpenCodeEntry } from "./setup";

export interface McpSummary {
  hasJournal: boolean;
  journalPath: string;
  serverStarts: number;
  sessions: number;
  toolCalls: number;
  toolErrors: number;
  lastActivity: string | null;
  lastTool: string | null;
  eventCount: number;
}

/**
 * Summarize the workspace MCP journal. The journal is written by the
 * `@astrivya/mcp-server` to `<workspace>/.astrivya/mcp/events.ndjson`.
 */
export function summarizeMcpJournal(workspace: string): McpSummary {
  const events = readJournal(workspace, 5000);
  const serverStarts = events.filter((e) => e.type === "server_start").length;
  const sessions = events.filter((e) => e.type === "session_start").length;
  const toolCalls = events.filter((e) => e.type === "tool_call").length;
  const toolErrors = events.filter((e) => e.type === "tool_call" && e.ok === false).length;
  const lastToolCall = [...events].reverse().find((e) => e.type === "tool_call");
  const lastEvent = events[events.length - 1];

  return {
    hasJournal: events.length > 0,
    journalPath: journalPath(workspace),
    serverStarts,
    sessions,
    toolCalls,
    toolErrors,
    lastActivity: lastEvent ? lastEvent.ts : null,
    lastTool: lastToolCall ? String(lastToolCall.tool || "unknown") : null,
    eventCount: events.length,
  };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function renderSummary(s: McpSummary): void {
  console.log("\n  Astrivya MCP Server — this workspace");
  console.log(`  ${"─".repeat(40)}`);

  if (!s.hasJournal) {
    console.log(`  ${color.dim("No MCP activity recorded for this workspace yet.")}`);
    console.log(`  ${color.dim("The journal appears when an AI agent using Astrivya MCP")}`);
    console.log(`  ${color.dim("runs here. Configure it with:")}`);
    console.log(`  ${color.cyan("  astrivya setup --detect")}`);
    console.log();
    return;
  }

  console.log(`  Journal:       ${color.dim(s.journalPath)}`);
  console.log(`  Server starts: ${color.bold(String(s.serverStarts))}`);
  console.log(`  Sessions:      ${color.bold(String(s.sessions))}`);
  console.log(
    `  Tool calls:    ${color.bold(String(s.toolCalls))}${s.toolErrors > 0 ? color.yellow(` (${s.toolErrors} errors)`) : ""}`,
  );
  if (s.lastActivity) console.log(`  Last activity: ${color.dim(formatDate(s.lastActivity))}`);
  if (s.lastTool) console.log(`  Last tool:     ${color.cyan(s.lastTool)}`);
  console.log();
  console.log(`  ${color.dim("Full timeline:")} ${color.cyan("astrivya mcp log")}`);
  console.log();
}

async function installToolEntry(tool: ToolDetector, apiUrl: string): Promise<void> {
  const existing = tool.readConfig();
  if (tool.name === "OpenCode") {
    const mcp = ((existing as any).mcp || {}) as Record<string, unknown>;
    mcp.astrivya = buildOpenCodeEntry(apiUrl);
    (existing as any).mcp = mcp;
  } else {
    const servers = ((existing as any).mcpServers || {}) as Record<string, unknown>;
    servers.astrivya = buildMcpServiceEntry(apiUrl);
    (existing as any).mcpServers = servers;
  }
  tool.writeConfig(existing);
}

function uninstallToolEntry(tool: ToolDetector): boolean {
  const existing = tool.readConfig();
  let removed = false;
  if (tool.name === "OpenCode") {
    const mcp = (existing as any).mcp as Record<string, unknown> | undefined;
    if (mcp?.astrivya) {
      Reflect.deleteProperty(mcp, "astrivya");
      if (Object.keys(mcp).length === 0) Reflect.deleteProperty(existing as any, "mcp");
      removed = true;
    }
  } else {
    const servers = (existing as any).mcpServers as Record<string, unknown> | undefined;
    if (servers?.astrivya) {
      Reflect.deleteProperty(servers, "astrivya");
      if (Object.keys(servers).length === 0) Reflect.deleteProperty(existing as any, "mcpServers");
      removed = true;
    }
  }
  if (removed) tool.writeConfig(existing);
  return removed;
}

export function registerMcp(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Inspect the Astrivya MCP server activity journal for this workspace")
    .option("--json", "Output raw JSON")
    .action(async (options) => {
      const s = summarizeMcpJournal(process.cwd());
      if (options.json) {
        printJson(s);
        return;
      }
      renderSummary(s);
    });

  mcp
    .command("log")
    .description("Show recent events from the Astrivya MCP server journal")
    .option("-n, --limit <number>", "Number of events to show", "30")
    .option("--json", "Output raw JSON")
    .action((options) => {
      const limit = Math.max(1, Number.parseInt(options.limit, 10) || 30);
      const events = readJournal(process.cwd(), limit);
      if (events.length === 0) {
        console.log(color.dim("No MCP journal entries yet for this workspace."));
        return;
      }
      if (options.json) {
        printJson(events);
        return;
      }
      for (const e of events) {
        const icon =
          e.type === "server_start"
            ? color.bold("start")
            : e.type === "server_stop"
              ? color.yellow("stop")
              : e.type === "session_start"
                ? color.cyan("session")
                : e.type === "session_end"
                  ? color.dim("end")
                  : e.type === "tool_call"
                    ? `tool ${String(e.tool || "?")} ${e.ok ? color.green("ok") : color.red("err")}`
                    : String(e.type);
        console.log(`  ${color.dim(formatDate(String(e.ts)))}  ${icon}`);
      }
      console.log();
      console.log(`  ${color.dim(`${events.length} event(s) from ${journalPath(process.cwd())}`)}`);
    });

  mcp
    .command("install")
    .description("Add the Astrivya MCP server entry to every detected agent config (same as `setup --detect`)")
    .action(async () => {
      const apiUrl = getBaseUrl();
      let ok = 0;
      let skipped = 0;
      console.log("\n  Installing Astrivya MCP into agent configs...");
      for (const tool of ALL_TOOLS) {
        if (!tool.detect()) {
          console.log(`  ${color.dim("\u25CB")} ${tool.name}${color.dim(" — not detected")}`);
          skipped++;
          continue;
        }
        try {
          await installToolEntry(tool, apiUrl);
          console.log(`  ${color.green("\u2713")} ${tool.name} — configured`);
          ok++;
        } catch (err: unknown) {
          skipped++;
          console.log(`  ${color.red("\u2717")} ${tool.name} — ${getErrorMessage(err)}`);
        }
      }
      console.log(`\n  ${ok} configured, ${skipped} skipped.\n`);
    });

  mcp
    .command("uninstall")
    .description("Remove the Astrivya MCP server entry from every detected agent config")
    .action(async () => {
      let removed = 0;
      let skipped = 0;
      console.log("\n  Removing Astrivya MCP from agent configs...");
      for (const tool of ALL_TOOLS) {
        try {
          if (uninstallToolEntry(tool)) {
            console.log(`  ${color.yellow("\u2212")} ${tool.name} — removed`);
            removed++;
          } else {
            console.log(`  ${color.dim("\u25CB")} ${tool.name} — no Astrivya entry`);
            skipped++;
          }
        } catch (err: unknown) {
          skipped++;
          console.log(`  ${color.red("\u2717")} ${tool.name} — ${getErrorMessage(err)}`);
        }
      }
      console.log(`\n  ${removed} removed, ${skipped} had no entry.\n`);
      if (removed > 0) {
        console.log(`  ${color.dim("Restart your agents after removing the entry.")}\n`);
      }
    });
}