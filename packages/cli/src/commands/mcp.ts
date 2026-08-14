import { journalPath, readJournal } from "@astrivya/mcp-server";
import type { Command } from "commander";
import { ensureAuth } from "../lib/auth-guard";
import { apiCall, getBaseUrl, loadConfig } from "../lib/compat";
import { color, getErrorMessage, json as printJson } from "../lib/output";
import { ALL_TOOLS, type ToolDetector, buildMcpServiceEntry, buildOpenCodeEntry } from "./setup";

export interface McpSummary {
  hasJournal: boolean;
  journalPath: string;
  serverStarts: number;
  sessions: number;
  activeSessions: number;
  toolCalls: number;
  toolErrors: number;
  lastActivity: string | null;
  lastTool: string | null;
  eventCount: number;
}

/**
 * Probe whether a PID is currently alive. `process.kill(pid, 0)` throws ESRCH
 * when the process does not exist and EPERM when it exists but is owned by
 * another user. PID reuse can mislabel a recycled PID as active — accepted
 * (worst case one wrong row, same as before this probe).
 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Summarize the workspace MCP journal. The journal is written by the
 * `@astrivya/mcp-server` to `<workspace>/.astrivya/mcp/events.ndjson`.
 */
export function summarizeMcpJournal(workspace: string): McpSummary {
  const events = readJournal(workspace, 5000);
  const serverStarts = events.filter((e) => e.type === "server_start").length;
  const toolCalls = events.filter((e) => e.type === "tool_call").length;
  const toolErrors = events.filter((e) => e.type === "tool_call" && e.ok === false).length;
  const lastToolCall = [...events].reverse().find((e) => e.type === "tool_call");
  const lastEvent = events[events.length - 1];

  // Active = started, not ended, AND the owning process is still alive.
  // Without the liveness probe, hard-killed processes (which never write a
  // session_end) would count as active forever.
  const activeSessions = journalSessionRows(events).filter((r) => r.state === "active").length;

  return {
    hasJournal: events.length > 0,
    journalPath: journalPath(workspace),
    serverStarts,
    sessions: events.filter((e) => e.type === "session_start").length,
    activeSessions,
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
  console.log(`  Sessions:      ${color.bold(`${s.activeSessions} active / ${s.sessions} total`)}`);
  console.log(
    `  Tool calls:    ${color.bold(String(s.toolCalls))}${s.toolErrors > 0 ? color.yellow(` (${s.toolErrors} errors)`) : ""}`,
  );
  if (s.lastActivity) console.log(`  Last activity: ${color.dim(formatDate(s.lastActivity))}`);
  if (s.lastTool) console.log(`  Last tool:     ${color.cyan(s.lastTool)}`);
  console.log();
  console.log(`  ${color.dim("Full timeline:")} ${color.cyan("astrivya mcp log")}`);
  console.log(`  ${color.dim("Live sessions:")} ${color.cyan("astrivya mcp status --live")}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Live HTTP probing — reads the server's own registry, not the journal.
// ---------------------------------------------------------------------------

const DEFAULT_MCP_HTTP = "http://localhost:3001";

function mcpHttpBase(): string {
  return (process.env.ASTRIVYA_MCP_URL || DEFAULT_MCP_HTTP).replace(/\/+$/, "");
}

async function fetchMcpLive(pathname: string, timeoutMs = 2500): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${mcpHttpBase()}${pathname}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export interface SessionRow {
  id: string;
  client: string | null;
  pid: number | null;
  /** True when the session predates session ids (pid-keyed legacy journal rows). */
  legacy: boolean;
  state: "active" | "orphan" | "ended";
  toolCalls: number;
  lastTool: string | null;
}

/**
 * Derive a per-session table from journal events (active first, newest last
 * activity first). Sessions without a `session_end` are classified by PID
 * liveness: alive → `active`, dead → `orphan` (the process was hard-killed and
 * never wrote an end event). The `isAlive` probe is injectable for tests.
 */
export function journalSessionRows(
  events: Array<Record<string, unknown>>,
  isAlive: (pid: number | null) => boolean = isPidAlive,
): SessionRow[] {
  // Key by session id when present (pid-independent — tool_call events only
  // carry the pid when written by the session-aware server); legacy events
  // without ids fall back to a pid-scoped key.
  const key = (e: Record<string, unknown>) =>
    e.session_id ? `sid:${String(e.session_id)}` : `pid:${String(e.pid ?? "?")}`;
  const sessions = new Map<string, { client: string | null; pid: number | null; ended: boolean; toolCalls: number; lastTool: string | null; lastTs: number }>();

  for (const e of events) {
    const k = key(e);
    if (e.type === "session_start") {
      if (!sessions.has(k)) {
        const pid = Number(e.pid);
        sessions.set(k, { client: (e.client as string | null) ?? null, pid: pid > 0 ? pid : null, ended: false, toolCalls: 0, lastTool: null, lastTs: Date.parse(String(e.ts)) || 0 });
      }
    } else if (e.type === "session_end") {
      const s = sessions.get(k);
      if (s) s.ended = true;
    } else if (e.type === "tool_call" && (e.session_id || e.pid)) {
      const s = sessions.get(k);
      if (s) {
        s.toolCalls++;
        s.lastTool = String(e.tool ?? "?");
        s.lastTs = Date.parse(String(e.ts)) || s.lastTs;
      }
    }
  }

  const rank = { active: 0, orphan: 1, ended: 2 } as const;
  return [...sessions.entries()]
    .map(([id, s]) => {
      const legacy = id.startsWith("pid:");
      const state: SessionRow["state"] = s.ended ? "ended" : isAlive(s.pid) ? "active" : "orphan";
      const display = legacy ? id : id.replace(/^sid:/, "");
      return { id: display, ...s, legacy, state };
    })
    .sort((a, b) => {
      if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
      return b.lastTs - a.lastTs;
    })
    .map(({ lastTs: _lastTs, ...row }) => row);
}

function renderLiveStatus(live: Record<string, unknown>, tokens: Record<string, unknown> | null, link: boolean): void {
  const sessions = (live.sessionsList || []) as Array<{
    id: string;
    client: string | null;
    mode: string;
    startedAt: number;
    lastActiveAt: number;
    toolCalls: number;
    lastTool: string | null;
    endedAt: number | null;
  }>;
  const tools = (live.tools || {}) as Record<string, { count: number; errors: number; lastMs: number | null; p50Ms: number | null; p95Ms: number | null }>;

  console.log(`\n  Astrivya MCP Server — ${color.green("live")}`);
  console.log(`  ${"\u2500".repeat(46)}`);
  console.log(`  Endpoint:      ${color.cyan(`${mcpHttpBase()}/mcp`)}`);
  console.log(`  Version:       ${color.bold(String(live.version || "?"))}`);
  console.log(`  Mode:          ${String(live.mode || "?")} (pid ${String(live.pid ?? "?")})`);
  if (live.workspace) console.log(`  Workspace:     ${color.dim(String(live.workspace))}`);
  console.log(
    `  Uptime:        ${formatDuration(Number(live.uptimeMs) || 0)}${live.journalRotated ? color.yellow(" (journal rotated)") : ""}`,
  );
  console.log(
    `  Sessions:      ${color.bold(`${Number(live.activeSessions) || 0} active / ${Number(live.sessions) || 0} total`)}`,
  );
  console.log(
    `  Tool calls:    ${color.bold(String(live.toolCalls ?? 0))}${Number(live.toolErrors) > 0 ? color.yellow(` (${String(live.toolErrors)} errors)`) : ""}`,
  );

  if (sessions.length > 0) {
    console.log();
    console.log(`  ${color.bold("Live sessions")}`);
    console.log(`  ${color.dim("  ID        CLIENT   MODE  UPTIME    TOOLS  LAST TOOL")}`);
    for (const s of sessions) {
      const active = !s.endedAt;
      const state = active ? color.green("ACTIVE") : color.dim("ended");
      const uptime = active
        ? formatDuration(Date.now() - s.startedAt)
        : formatDuration((s.endedAt || s.lastActiveAt) - s.startedAt);
      const client = (s.client || "-").slice(0, 7).padEnd(7);
      const prefix = active ? "" : color.dim("");
      console.log(
        `${prefix}  ${shortId(s.id).padEnd(8)}  ${client}  ${String(s.mode).padEnd(4)}  ${uptime.padEnd(8)}  ${String(s.toolCalls).padEnd(5)}  ${active ? color.cyan(String(s.lastTool ?? "-")) : color.dim(String(s.lastTool ?? "-"))}  ${state}`,
      );
    }
  }

  const toolNames = Object.keys(tools);
  if (toolNames.length > 0) {
    console.log();
    console.log(`  ${color.bold("Per-tool latency")}`);
    console.log(`  ${color.dim("  TOOL                 CALLS  ERR  P50     P95     LAST")}`);
    for (const name of toolNames.sort()) {
      const t = tools[name];
      const fmt = (ms: number | null) => (ms == null ? "-" : `${ms}ms`);
      console.log(
        `  ${name.padEnd(20)} ${String(t.count).padEnd(6)} ${String(t.errors).padEnd(4)} ${fmt(t.p50Ms).padEnd(7)} ${fmt(t.p95Ms).padEnd(7)} ${fmt(t.lastMs)}`,
      );
    }
  }

  if (tokens) {
    console.log();
    console.log(`  ${color.bold("Credits")}`);
    console.log(`  Balance:       ${color.green(`${String(tokens.balance ?? "?")} credits`)}`);
    console.log(`  Details:       ${color.cyan("astrivya credits")}`);
  }

  if (link) {
    console.log();
    console.log(`  ${color.bold("Atlas")}`);
    console.log(`  URL:           ${color.cyan("http://localhost:4200")} (Sessions panel)`);
    console.log(`  Run:           ${color.cyan("astrivya serve")}`);
  }

  if (live.journal) console.log(`\n  Journal:       ${color.dim(String(live.journal))}`);
  console.log();
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------------------
// Prometheus metrics (mcp metrics)
// ---------------------------------------------------------------------------

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderMetrics(live: Record<string, unknown> | null): void {
  const lines: string[] = [];
  const push = (name: string, help: string, type: string, samples: string[] | string) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    if (Array.isArray(samples)) lines.push(...samples);
    else lines.push(samples);
  };

  push(
    "astrivya_mcp_info",
    "Static metadata about the MCP server process.",
    "gauge",
    `astrivya_mcp_info{version="${escapeLabel(String(live?.version ?? "?"))}",pid="${String(live?.pid ?? "?")}",mode="${escapeLabel(String(live?.mode ?? "?"))}"} 1`,
  );
  push(
    "astrivya_mcp_sessions_total",
    "Lifetime session count for the server process.",
    "counter",
    `astrivya_mcp_sessions_total ${Number(live?.sessions ?? 0)}`,
  );
  push(
    "astrivya_mcp_active_sessions",
    "Sessions currently open (not idle-swept).",
    "gauge",
    `astrivya_mcp_active_sessions ${Number(live?.activeSessions ?? 0)}`,
  );
  push(
    "astrivya_mcp_uptime_seconds",
    "Seconds since the server process started.",
    "gauge",
    `astrivya_mcp_uptime_seconds ${Math.floor((Number(live?.uptimeMs ?? 0)) / 1000)}`,
  );

  const tools = (live?.tools || {}) as Record<string, { count: number; errors: number; p50Ms: number | null; p95Ms: number | null; lastMs: number | null }>;
  const calls: string[] = [];
  const errors: string[] = [];
  const latency: string[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const tool = escapeLabel(name);
    calls.push(`astrivya_mcp_tool_calls_total{tool="${tool}"} ${t.count}`);
    errors.push(`astrivya_mcp_tool_errors_total{tool="${tool}"} ${t.errors}`);
    for (const [q, v] of [
      ["p50", t.p50Ms],
      ["p95", t.p95Ms],
      ["last", t.lastMs],
    ] as const) {
      if (v != null) latency.push(`astrivya_mcp_tool_duration_ms{tool="${tool}",quantile="${q}"} ${v}`);
    }
  }
  push("astrivya_mcp_tool_calls_total", "Tool invocations by tool name.", "counter", calls);
  push("astrivya_mcp_tool_errors_total", "Errored tool invocations by tool name.", "counter", errors);
  push(
    "astrivya_mcp_tool_duration_ms",
    "Tool latency in milliseconds (p50/p95 over the sample window, last observed).",
    "gauge",
    latency,
  );

  const sessions = (live?.sessionsList || []) as Array<{ id: string; client: string | null; mode: string; startedAt: number; toolCalls: number; endedAt: number | null }>;
  const sessionInfo: string[] = [];
  const sessionCalls: string[] = [];
  const sessionUptime: string[] = [];
  for (const s of sessions) {
    const sid = escapeLabel(s.id);
    const client = escapeLabel(s.client || "");
    sessionInfo.push(
      `astrivya_mcp_session_info{session="${sid}",client="${client}",mode="${escapeLabel(s.mode)}",state="${s.endedAt ? "ended" : "active"}"} 1`,
    );
    sessionCalls.push(`astrivya_mcp_session_tool_calls_total{session="${sid}"} ${s.toolCalls}`);
    const uptimeSec = Math.floor((Date.now() - s.startedAt) / 1000);
    sessionUptime.push(`astrivya_mcp_session_uptime_seconds{session="${sid}"} ${Math.max(0, uptimeSec)}`);
  }
  push("astrivya_mcp_session_info", "Per-session metadata (id, client, state).", "gauge", sessionInfo);
  push("astrivya_mcp_session_tool_calls_total", "Tool calls attributed to each session.", "counter", sessionCalls);
  push("astrivya_mcp_session_uptime_seconds", "Seconds since each session started.", "gauge", sessionUptime);

  push(
    "astrivya_mcp_journal_size_bytes",
    "Size of the on-disk event journal for the server's workspace.",
    "gauge",
    `astrivya_mcp_journal_size_bytes ${Number(live?.journalSizeBytes ?? 0)}`,
  );

  console.log(lines.join("\n"));
  console.log("# EOF");
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
                ? color.cyan(`session ${e.session_id ? shortId(String(e.session_id)) : ""}`)
                : e.type === "session_end"
                  ? color.dim(`end ${e.session_id ? shortId(String(e.session_id)) : ""}`)
                  : e.type === "tool_call"
                    ? `tool ${String(e.tool || "?")} ${e.ok ? color.green("ok") : color.red("err")}${e.session_id ? ` ${color.dim(shortId(String(e.session_id)))}` : ""}`
                    : String(e.type);
        console.log(`  ${color.dim(formatDate(String(e.ts)))}  ${icon}`);
      }
      console.log();
      console.log(`  ${color.dim(`${events.length} event(s) from ${journalPath(process.cwd())}`)}`);
    });

  mcp
    .command("status")
    .description("Session registry + health. Add --live to probe the running HTTP server directly")
    .option("--live", "Probe the running MCP HTTP server (ASTRIVYA_MCP_URL, default http://localhost:3001)")
    .option("--tokens", "Also fetch the cloud credit balance")
    .option("--link", "Show the Atlas sessions panel URL")
    .option("--all", "Expand legacy (pre-session-id) sessions instead of collapsing them")
    .option("--json", "Output raw JSON")
    .action(async (options) => {
      const events = readJournal(process.cwd(), 5000);
      const wantLive = Boolean(options.live);

      if (wantLive) {
        const live = await fetchMcpLive("/status");
        if (!live) {
          console.error(
            color.red(`No MCP HTTP server reachable at ${mcpHttpBase()}.`),
          );
          console.error(color.dim("  Start one with:  astrivya mcp-server --http --port 3001"));
          console.error(color.dim("  Or point ASTRIVYA_MCP_URL at the right endpoint."));
          process.exitCode = 1;
          return;
        }
        let tokens: Record<string, unknown> | null = null;
        if (options.tokens) {
          tokens = await fetchMcpLive("/tokens").catch(() => null);
          if (!tokens) {
            try {
              const config = loadConfig();
              if (!config.offlineMode && (await ensureAuth())) {
                tokens = await apiCall("/api/credits/balance", "GET");
              }
            } catch {
              tokens = null;
            }
          }
        }
        if (options.json) {
          printJson({ live, tokens });
          return;
        }
        renderLiveStatus(live, tokens, Boolean(options.link));
        return;
      }

      if (options.json) {
        const live = await fetchMcpLive("/status");
        printJson({ summary: summarizeMcpJournal(process.cwd()), live });
        return;
      }

      const s = summarizeMcpJournal(process.cwd());
      renderSummary(s);

      const rows = journalSessionRows(events);
      const modern = rows.filter((r) => !r.legacy);
      const legacy = rows.filter((r) => r.legacy);

      if (modern.length > 0) {
        console.log(`  ${color.bold("Sessions")}`);
        console.log(`  ${color.dim("  ID        CLIENT    STATE   TOOLS  LAST TOOL")}`);
        for (const r of modern) {
          const state = r.state === "active" ? color.green("ACTIVE") : r.state === "orphan" ? color.dim("orphan") : color.dim("ended");
          const dim = r.state !== "active" ? color.dim("") : "";
          console.log(
            `  ${shortId(r.id).padEnd(8)}  ${(r.client || "-").slice(0, 8).padEnd(8)}  ${dim}${state}  ${String(r.toolCalls).padEnd(5)}  ${r.state === "active" ? color.cyan(String(r.lastTool ?? "-")) : color.dim(String(r.lastTool ?? "-"))}`,
          );
        }
        console.log();
      }

      if (legacy.length > 0) {
        if (options.all) {
          console.log(`  ${color.bold("Sessions (legacy, pre-session-id)")}`);
          console.log(`  ${color.dim("  ID        CLIENT    STATE   TOOLS  LAST TOOL")}`);
          for (const r of legacy) {
            const state = r.state === "active" ? color.green("ACTIVE") : r.state === "orphan" ? color.dim("orphan") : color.dim("ended");
            console.log(
              `  ${r.id.padEnd(8)}  ${(r.client || "-").slice(0, 8).padEnd(8)}  ${state}  ${String(r.toolCalls).padEnd(5)}  ${color.dim(String(r.lastTool ?? "-"))}`,
            );
          }
          console.log();
        } else {
          const alive = legacy.filter((r) => r.state === "active").length;
          const orphaned = legacy.filter((r) => r.state === "orphan").length;
          const ended = legacy.filter((r) => r.state === "ended").length;
          console.log(`  ${color.dim(`${legacy.length} legacy sessions (pre-session-id journal) — ${alive} alive / ${orphaned} orphaned${ended > 0 ? ` / ${ended} ended` : ""}`)}`);
          console.log(`  ${color.dim("  expand with --all")}`);
          console.log();
        }
      }

      if (!s.hasJournal) {
        console.log(color.dim("Tip: run `astrivya mcp status --live` to probe a running HTTP server."));
      }
    });

  mcp
    .command("metrics")
    .description("Prometheus-style metrics. Prefers the live HTTP server, falls back to the journal")
    .option("--journal", "Force journal-derived metrics (no HTTP probe)")
    .action(async (options) => {
      let live: Record<string, unknown> | null = null;
      if (!options.journal) {
        live = await fetchMcpLive("/status");
      }
      renderMetrics(live);
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
