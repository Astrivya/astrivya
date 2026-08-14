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
 * MCP server status tracker with a live per-session registry.
 *
 * Keeps an in-memory registry of every client session (id, client, mode,
 * lifetime counters) plus per-tool latency stats (p50/p95 over a bounded ring
 * buffer), and appends every notable event (server start/stop, session
 * start/end, tool calls) as NDJSON lines to
 * `<workspace>/.astrivya/mcp/events.ndjson` with session ids attached.
 *
 * The HTTP `/status` endpoint and `get_mcp_status` tool surface the registry
 * so end users can answer "what sessions is my MCP server serving, and how
 * healthy are they?" without touching the protocol channel. Idle sessions are
 * auto-ended after a grace period so the live list never shows ghosts.
 */

export interface SessionInfo {
  id: string;
  client: string | null;
  mode: "stdio" | "http";
  startedAt: number;
  lastActiveAt: number;
  endedAt: number | null;
  toolCalls: number;
  /** Tool name -> call count for this session. */
  tools: Record<string, number>;
  lastTool: string | null;
  lastToolAt: number | null;
}

export interface ToolStats {
  count: number;
  errors: number;
  lastMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface McpStatusSnapshot {
  version: string;
  pid: number;
  mode: "stdio" | "http";
  workspace: string;
  startedAt: number;
  uptimeMs: number;
  /** Lifetime session count (this process). */
  sessions: number;
  /** Sessions currently open (not ended, not idle-swept). */
  activeSessions: number;
  toolCalls: number;
  toolErrors: number;
  tools: Record<string, ToolStats>;
  /** Live session registry (active first, then recently ended). */
  sessionsList: SessionInfo[];
  journal: string;
  /** True after the journal has been rotated at least once. */
  journalRotated: boolean;
  /** Current size of the on-disk journal in bytes. */
  journalSizeBytes: number;
}

export interface JournalEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface SessionStartOptions {
  id?: string;
  client?: string | null;
  mode?: "stdio" | "http";
}

export interface ToolCallOptions {
  sessionId?: string;
  durationMs?: number;
  client?: string | null;
}

/** Sessions idle longer than this are auto-ended and reported as ended. */
export const IDLE_SESSION_MS = 30 * 60 * 1000;
/** Bounded latency ring per tool; keeps percentile math cheap and stable. */
const MAX_LATENCY_SAMPLES = 256;
/** Rotate the journal when it exceeds this size (keeps `mcp log` snappy). */
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;
/** Ended sessions kept in the registry before being dropped. */
const MAX_ENDED_SESSIONS = 40;

let _version = "";
let _mode: "stdio" | "http" = "stdio";
let _workspace = "";
let _startedAt = 0;
let _sessions = 0;
let _journalDir = "";
let _journalRotated = false;

const _sessionsMap = new Map<string, SessionInfo>();
const _endedQueue: string[] = [];
const _toolStats = new Map<string, ToolStats>();
const _toolLatency = new Map<string, number[]>();
let _toolCalls = 0;
let _toolErrors = 0;

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

/**
 * Register a client session. Returns the session id. When `id` is omitted a
 * stdio-style id is derived from the pid (one session per stdio process).
 */
export function recordSessionStart(opts?: SessionStartOptions): string {
  const id = opts?.id || `stdio:${process.pid}`;
  const existing = _sessionsMap.get(id);
  if (existing && !existing.endedAt) return id; // already active — just touch it

  _sessions++;
  const now = Date.now();
  const mode = opts?.mode || _mode;
  _sessionsMap.set(id, {
    id,
    client: opts?.client ?? null,
    mode,
    startedAt: now,
    lastActiveAt: now,
    endedAt: null,
    toolCalls: 0,
    tools: {},
    lastTool: null,
    lastToolAt: null,
  });
  const idx = _endedQueue.indexOf(id);
  if (idx !== -1) _endedQueue.splice(idx, 1);
  appendEvent("session_start", {
    session_id: id,
    client: opts?.client ?? null,
    mode,
    pid: process.pid,
  });
  telemetrySessionStart({ sessionId: id, client: opts?.client ?? null });
  return id;
}

/**
 * Register a session observed on an already-initialized transport (e.g. HTTP
 * reconnects after a server restart). Never ends an existing active session.
 */
export function ensureSession(id: string, client?: string | null, mode?: "stdio" | "http"): SessionInfo {
  const existing = _sessionsMap.get(id);
  if (existing && !existing.endedAt) return existing;
  return _sessionsMap.get(recordSessionStart({ id, client, mode })) as SessionInfo;
}

/** Touch a session's last-active timestamp (any request on the transport). */
export function touchSession(id: string): void {
  const s = _sessionsMap.get(id);
  if (s) s.lastActiveAt = Date.now();
}

/**
 * Close a session. When `id` is omitted, all active sessions are ended (used
 * at shutdown). Idle-swept sessions are ended through here too.
 */
export function recordSessionEnd(id?: string): void {
  const now = Date.now();
  const endOne = (s: SessionInfo) => {
    s.endedAt = s.endedAt ?? now;
    s.lastActiveAt = Math.max(s.lastActiveAt, s.endedAt);
    appendEvent("session_end", {
      session_id: s.id,
      client: s.client,
      mode: s.mode,
      tool_calls: s.toolCalls,
      pid: process.pid,
    });
    telemetrySessionEnd({ sessionId: s.id, toolCalls: s.toolCalls, client: s.client });
    _endedQueue.push(s.id);
    if (_endedQueue.length > MAX_ENDED_SESSIONS) {
      const drop = _endedQueue.shift();
      if (drop) _sessionsMap.delete(drop);
    }
  };

  if (id) {
    const s = _sessionsMap.get(id);
    if (s && !s.endedAt) endOne(s);
    return;
  }
  for (const s of _sessionsMap.values()) {
    if (!s.endedAt) endOne(s);
  }
}

/** Auto-end sessions idle past the grace period. Called before any snapshot. */
export function sweepIdleSessions(now = Date.now()): void {
  for (const s of _sessionsMap.values()) {
    if (!s.endedAt && now - s.lastActiveAt > IDLE_SESSION_MS) {
      recordSessionEnd(s.id);
    }
  }
}

/**
 * Record a tool invocation. `ok` is false when the tool returned an error.
 * `durationMs` feeds the per-tool latency ring (p50/p95). `sessionId` threads
 * the call into the owning session's counters.
 */
export function recordToolCall(name: string, ok: boolean, opts?: ToolCallOptions): void {
  const now = Date.now();
  _toolCalls++;
  if (!ok) _toolErrors++;

  const stats = _toolStats.get(name) ?? { count: 0, errors: 0, lastMs: null, p50Ms: null, p95Ms: null };
  stats.count++;
  if (!ok) stats.errors++;
  if (opts?.durationMs != null) {
    stats.lastMs = opts.durationMs;
    const ring = _toolLatency.get(name) ?? [];
    ring.push(opts.durationMs);
    if (ring.length > MAX_LATENCY_SAMPLES) ring.splice(0, ring.length - MAX_LATENCY_SAMPLES);
    _toolLatency.set(name, ring);
    const [p50, p95] = percentiles(ring);
    stats.p50Ms = p50;
    stats.p95Ms = p95;
  }
  _toolStats.set(name, stats);

  if (opts?.sessionId) {
    const s = _sessionsMap.get(opts.sessionId);
    if (s && !s.endedAt) {
      s.toolCalls++;
      s.tools[name] = (s.tools[name] || 0) + 1;
      s.lastTool = name;
      s.lastToolAt = now;
      s.lastActiveAt = now;
    }
  }

  appendEvent("tool_call", {
    tool: name,
    ok,
    session_id: opts?.sessionId ?? null,
    client: opts?.client ?? null,
    duration_ms: opts?.durationMs ?? null,
    pid: process.pid,
  });
  telemetryToolCall({
    sessionId: opts?.sessionId ?? undefined,
    tool: name,
    ok,
    durationMs: opts?.durationMs,
  });
}

/** Flush a final `server_stop` event. Best-effort; never throws. */
export function recordServerStop(reason = "shutdown"): void {
  recordSessionEnd();
  telemetryServerStop(reason, Date.now() - _startedAt);
  appendEvent("server_stop", { reason, pid: process.pid, uptimeMs: Date.now() - _startedAt });
}

/** Append a custom event to the journal (e.g. `auto_index`, `embed_*`). */
export function recordEvent(type: string, data: Record<string, unknown> = {}, workspace?: string): void {
  appendEvent(type, data, workspace);
}

/** Current in-memory status of the running server process. */
export function getStatus(): McpStatusSnapshot {
  sweepIdleSessions();
  const sessionsList = [..._sessionsMap.values()].sort((a, b) => {
    if (!!a.endedAt !== !!b.endedAt) return a.endedAt ? 1 : -1;
    return b.lastActiveAt - a.lastActiveAt;
  });
  const tools: Record<string, ToolStats> = {};
  for (const [name, stats] of _toolStats) tools[name] = { ...stats };
  const journalFile = path.join(_journalDir, "events.ndjson");
  let journalSizeBytes = 0;
  try {
    journalSizeBytes = fs.statSync(journalFile).size;
  } catch {
    // journal not written yet
  }
  return {
    version: _version,
    pid: process.pid,
    mode: _mode,
    workspace: _workspace,
    startedAt: _startedAt,
    uptimeMs: Date.now() - _startedAt,
    sessions: _sessions,
    activeSessions: sessionsList.filter((s) => !s.endedAt).length,
    toolCalls: _toolCalls,
    toolErrors: _toolErrors,
    tools,
    sessionsList,
    journal: journalFile,
    journalRotated: _journalRotated,
    journalSizeBytes,
  };
}

/** Absolute path of the workspace journal file for a given workspace. */
export function journalPath(workspace: string): string {
  return path.join(workspace, ".astrivya", "mcp", "events.ndjson");
}

/**
 * Read the last `limit` events from a workspace journal (newest last). Reads
 * the rotated archive first, then the live file, so ordering is preserved.
 */
export function readJournal(workspace: string, limit = 100): JournalEvent[] {
  const events: JournalEvent[] = [];
  const readFile = (file: string) => {
    if (!fs.existsSync(file)) return;
    try {
      const lines = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as JournalEvent);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // best-effort
    }
  };
  readFile(path.join(workspace, ".astrivya", "mcp", "events.ndjson.1"));
  readFile(path.join(workspace, ".astrivya", "mcp", "events.ndjson"));
  return events.slice(-limit);
}

function percentiles(samples: number[]): [number | null, number | null] {
  if (samples.length === 0) return [null, null];
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
  return [at(0.5), at(0.95)];
}

function appendEvent(type: string, data: Record<string, unknown>, workspace?: string): void {
  // Fall back to a workspace-derived journal dir when initStatus hasn't run
  // yet (e.g. auto_index events recorded during startup indexing).
  const dir = _journalDir || (workspace ? path.join(workspace, ".astrivya", "mcp") : "");
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "events.ndjson");
    rotateIfNeeded(file);
    const event: JournalEvent = { ts: new Date().toISOString(), type, ...data };
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // Journal is best-effort; never break the server over a write failure.
  }
}

/** Rotate a journal file once it exceeds the size cap (archive -> .1). */
function rotateIfNeeded(file: string): void {
  if (_journalRotated) return;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_JOURNAL_BYTES) {
      const archive = `${file}.1`;
      if (fs.existsSync(archive)) fs.unlinkSync(archive);
      fs.renameSync(file, archive);
      _journalRotated = true;
    }
  } catch {
    // no file yet or stat raced — nothing to rotate
  }
}
