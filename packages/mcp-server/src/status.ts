import * as fs from "node:fs";
import * as path from "node:path";
import {
  telemetryServerStart,
  telemetryServerStop,
  telemetrySessionEnd,
  telemetrySessionStart,
  telemetrySetTransport,
  telemetryToolCall,
} from "./telemetry";

/**
 * Lightweight MCP server status tracker.
 *
 * Keeps in-memory counters for the running process and appends every notable
 * event (server start/stop, session start/end, tool calls) as NDJSON lines to
 * `<workspace>/.astrivya/mcp/events.ndjson`. The CLI reads that journal back
 * with `astrivya mcp status` / `astrivya mcp log`, so end users can answer
 * "is my MCP server running and what has it been doing?" without touching the
 * protocol channel.
 */

export interface McpStatusSnapshot {
  version: string;
  pid: number;
  mode: "stdio" | "http";
  workspace: string;
  startedAt: number;
  uptimeMs: number;
  sessions: number;
  activeSessions: number;
  toolCalls: number;
  toolErrors: number;
  tools: Record<string, number>;
  journal: string;
}

export interface JournalEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

let _version = "";
let _mode: "stdio" | "http" = "stdio";
let _workspace = "";
let _startedAt = 0;
let _sessions = 0;
let _activeSessions = 0;
let _toolCalls = 0;
let _toolErrors = 0;
const _tools: Record<string, number> = {};
let _journalDir = "";

/** Initialize the tracker. Must be called once after the workspace is known. */
export function initStatus(opts: { workspace: string; mode: "stdio" | "http"; version: string }): void {
  _version = opts.version;
  _mode = opts.mode;
  _workspace = opts.workspace;
  _startedAt = Date.now();
  _journalDir = path.join(opts.workspace, ".astrivya", "mcp");
  appendEvent("server_start", { mode: opts.mode, version: opts.version, pid: process.pid });
  telemetrySetTransport(opts.mode);
  telemetryServerStart(opts.version);
}

/** Record a client session being established (initialize handshake). */
export function recordSessionStart(): void {
  _sessions++;
  _activeSessions++;
  appendEvent("session_start", { session: _sessions, pid: process.pid });
  telemetrySessionStart({ sessionId: `stdio:${process.pid}` });
}

/** Record a client session closing (HTTP DELETE, transport close, or shutdown). */
export function recordSessionEnd(): void {
  _activeSessions = Math.max(0, _activeSessions - 1);
  appendEvent("session_end", { session: _sessions, pid: process.pid });
  telemetrySessionEnd({ sessionId: `stdio:${process.pid}`, toolCalls: 0 });
}

/** Record a tool invocation result. `ok` is false when the tool returned an error. */
export function recordToolCall(name: string, ok: boolean): void {
  _toolCalls++;
  _tools[name] = (_tools[name] || 0) + 1;
  if (!ok) _toolErrors++;
  appendEvent("tool_call", { tool: name, ok });
  telemetryToolCall({ tool: name, ok });
}

/** Flush a final `server_stop` event. Best-effort; never throws. */
export function recordServerStop(reason = "shutdown"): void {
  appendEvent("server_stop", { reason, pid: process.pid, uptimeMs: Date.now() - _startedAt });
  telemetryServerStop(reason, Date.now() - _startedAt);
}

/** Append a custom event to the journal (e.g. `auto_index`, `embed_*`). */
export function recordEvent(type: string, data: Record<string, unknown> = {}, workspace?: string): void {
  appendEvent(type, data, workspace);
}

/** Current in-memory status of the running server process. */
export function getStatus(): McpStatusSnapshot {
  return {
    version: _version,
    pid: process.pid,
    mode: _mode,
    workspace: _workspace,
    startedAt: _startedAt,
    uptimeMs: Date.now() - _startedAt,
    sessions: _sessions,
    activeSessions: _activeSessions,
    toolCalls: _toolCalls,
    toolErrors: _toolErrors,
    tools: { ..._tools },
    journal: path.join(_journalDir, "events.ndjson"),
  };
}

/** Absolute path of the workspace journal file for a given workspace. */
export function journalPath(workspace: string): string {
  return path.join(workspace, ".astrivya", "mcp", "events.ndjson");
}

/** Read the last `limit` events from a workspace journal (newest last). */
export function readJournal(workspace: string, limit = 100): JournalEvent[] {
  try {
    const file = journalPath(workspace);
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const events: JournalEvent[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        events.push(JSON.parse(line) as JournalEvent);
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

function appendEvent(type: string, data: Record<string, unknown>, workspace?: string): void {
  // Fall back to a workspace-derived journal dir when initStatus hasn't run
  // yet (e.g. auto_index events recorded during startup indexing).
  const dir = _journalDir || (workspace ? path.join(workspace, ".astrivya", "mcp") : "");
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const event: JournalEvent = { ts: new Date().toISOString(), type, ...data };
    fs.appendFileSync(path.join(dir, "events.ndjson"), `${JSON.stringify(event)}\n`);
  } catch {
    // Journal is best-effort; never break the server over a write failure.
  }
}
