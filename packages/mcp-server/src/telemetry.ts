import { randomUUID } from "node:crypto";
// Anonymous, opt-out usage telemetry for the MCP server.
//
// Sends a small set of NON-IDENTIFYING events to the Astrivya PostHog project
// (public key — same project the web app uses). NEVER sends tool arguments,
// queries, file paths, tokens, or any other user data. Fire-and-forget: a
// failed send must never delay, crash, or block the server or the MCP channel.
//
// Opt-out: ASTRIVYA_TELEMETRY=off or NO_TELEMETRY=1 env vars. Automatically
// disabled in CI. Tool-call events are sampled (once per tool per session) to
// bound volume while keeping full coverage of which tools get used.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import envPaths from "env-paths";
import { CURRENT_VERSION } from "./lib/version";

/** Public PostHog key — embedded in the browser bundle too, safe to ship. */
const POSTHOG_KEY = "phc_BcfHVZzTt4GRwwkMJKgBEnCEuyF8nbDzzQxy6VBJZwfE";
const POSTHOG_CAPTURE_URL = "https://app.posthog.com/capture/";
const TIMEOUT_MS = 2500;

const paths = envPaths("astrivya-mcp", { suffix: "" });
const TELEMETRY_STATE_FILE = path.join(paths.cache, "telemetry.json");

export interface TelemetryState {
  installId: string;
  bannerShown?: boolean;
}

let _state: TelemetryState | null = null;
const _sampled: Map<string, Set<string>> = new Map();
let _transport: "stdio" | "http" = "stdio";
let _bannerEmitted = false;

export function isCI(): boolean {
  return Boolean(
    process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI || process.env.CIRCLECI || process.env.TRAVIS,
  );
}

/** Telemetry is opt-out: enabled unless disabled via env or running in CI. */
export function isTelemetryEnabled(): boolean {
  if (process.env.ASTRIVYA_TELEMETRY === "off" || process.env.NO_TELEMETRY === "1") return false;
  if (isCI()) return false;
  return true;
}

export function loadTelemetryState(): TelemetryState {
  if (_state) return _state;
  try {
    _state = JSON.parse(fs.readFileSync(TELEMETRY_STATE_FILE, "utf8")) as TelemetryState;
  } catch {
    _state = { installId: randomUUID() };
  }
  if (!_state.installId) _state.installId = randomUUID();
  return _state;
}

function persistTelemetryState(): void {
  if (!_state) return;
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_STATE_FILE), { recursive: true });
    fs.writeFileSync(TELEMETRY_STATE_FILE, JSON.stringify(_state, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

export function getInstallId(): string {
  const state = loadTelemetryState();
  persistTelemetryState();
  return state.installId;
}

/**
 * Print the one-time opt-out disclosure to stderr (stdout is the MCP stdio
 * protocol channel). Persisted per install; once per process.
 */
export function maybePrintTelemetryBanner(): void {
  if (!isTelemetryEnabled() || _bannerEmitted) return;
  _bannerEmitted = true;
  const state = loadTelemetryState();
  if (state.bannerShown) return;
  state.bannerShown = true;
  persistTelemetryState();
  console.error(
    "\u203A Anonymous usage stats are enabled (no code, paths, or queries are ever sent). " +
      "Disable: ASTRIVYA_TELEMETRY=off",
  );
}

/** Base properties attached to every event. */
export function baseTelemetryProps(): Record<string, string> {
  return {
    install_id: getInstallId(),
    product: "mcp-server",
    mcp_version: CURRENT_VERSION,
    node_version: process.version,
    os_name: os.platform(),
    os_version: os.release(),
    arch: os.arch(),
  };
}

/** Build the PostHog capture body. Exported for tests. Properties whose keys
 * are in `captureForbiddenKeys` are stripped here — the guard is structural,
 * not convention-based. */
export function buildCapturePayload(event: string, properties: Record<string, unknown> = {}) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (captureForbiddenKeys.includes(key)) continue;
    safe[key] = value;
  }
  return {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: getInstallId(),
    properties: { ...baseTelemetryProps(), ...safe },
  };
}

/** Keys that must NEVER appear in a telemetry payload. */
export const captureForbiddenKeys = [
  "path",
  "paths",
  "file",
  "files",
  "dir",
  "directory",
  "args",
  "arguments",
  "query",
  "content",
  "token",
  "secret",
  "key",
  "message",
  "stack",
  "error",
  "value",
  "input",
];

/**
 * Fire-and-forget anonymous event capture. Never throws, aborts after
 * TIMEOUT_MS, swallows all failures.
 */
export function capture(event: string, properties: Record<string, unknown> = {}): void {
  try {
    if (!isTelemetryEnabled()) return;
    const body = buildCapturePayload(event, properties);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    void fetch(POSTHOG_CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .catch(() => {
        // never let telemetry failures surface
      })
      .finally(() => clearTimeout(timer));
  } catch {
    // never throw from telemetry
  }
}

/** Called from status.initStatus — records transport mode for all events. */
export function telemetrySetTransport(transport: "stdio" | "http"): void {
  _transport = transport;
}

export function telemetryServerStart(version: string): void {
  capture("oss_mcp_server_start", { transport: _transport, server_version: version });
}

export function telemetryServerStop(reason: string, uptimeMs: number): void {
  capture("oss_mcp_server_stop", { transport: _transport, reason, uptime_ms: uptimeMs });
}

export function telemetrySessionStart(opts: { sessionId?: string; client?: string | null }): void {
  capture("oss_mcp_session_start", {
    transport: _transport,
    ...(opts.client ? { client_type: sanitizeClient(opts.client) } : {}),
  });
  if (opts.sessionId) _sampled.set(opts.sessionId, new Set());
}

export function telemetrySessionEnd(opts: { sessionId?: string; toolCalls: number; client?: string | null }): void {
  capture("oss_mcp_session_end", {
    transport: _transport,
    tool_calls: opts.toolCalls,
    ...(opts.client ? { client_type: sanitizeClient(opts.client) } : {}),
  });
  if (opts.sessionId) _sampled.delete(opts.sessionId);
}

/** Sampled tool-call event: at most once per (session, tool) — bounds volume. */
export function telemetryToolCall(opts: {
  sessionId?: string;
  tool: string;
  ok: boolean;
  durationMs?: number;
}): void {
  const key = opts.sessionId || "default";
  let seen = _sampled.get(key);
  if (!seen) {
    seen = new Set();
    _sampled.set(key, seen);
  }
  if (seen.has(opts.tool)) return;
  seen.add(opts.tool);
  capture("oss_mcp_tool_call", {
    transport: _transport,
    tool: opts.tool,
    ok: opts.ok,
    ...(opts.durationMs != null ? { duration_ms: opts.durationMs } : {}),
  });
}

/** Short client strings (user-agent → platform token). Never full user-agents. */
function sanitizeClient(client: string | null | undefined): string {
  if (!client) return "unknown";
  if (client === "stdio") return "stdio";
  if (client === "http") return "http";
  const lower = client.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("windsurf")) return "windsurf";
  if (lower.includes("jetbrains")) return "jetbrains";
  if (lower.includes("vscode")) return "vscode";
  if (lower.includes("atlas")) return "atlas";
  return "other";
}
