import { randomUUID } from "node:crypto";
// Anonymous, opt-out usage telemetry for the CLI.
//
// Sends a small set of NON-IDENTIFYING events to the Astrivya PostHog project
// (public key — same project the web app uses). NEVER sends file paths, command
// arguments, query content, tokens, or any other user data. Fire-and-forget:
// a failed send must never delay, crash, or block the CLI.
//
// Opt-out: `astrivya config set telemetry off` (persisted) or the
// ASTRIVYA_TELEMETRY=off / NO_TELEMETRY=1 env vars. Automatically disabled in CI.
import * as fs from "node:fs";
import { loadConfig } from "./compat";
import { getConfigPath } from "./config";
import { color } from "./output";
import { CURRENT_VERSION } from "./version";

/** Public PostHog key — embedded in the browser bundle too, safe to ship. */
const POSTHOG_KEY = "phc_BcfHVZzTt4GRwwkMJKgBEnCEuyF8nbDzzQxy6VBJZwfE";
const POSTHOG_CAPTURE_URL = "https://app.posthog.com/capture/";
const TIMEOUT_MS = 2500;

export interface TelemetryState {
  installId: string;
  bannerShown?: boolean;
}

let _state: TelemetryState | null = null;

export function isCI(): boolean {
  return Boolean(
    process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI || process.env.CIRCLECI || process.env.TRAVIS,
  );
}

/** Telemetry is opt-out: enabled unless the user disabled it or runs in CI. */
export function isTelemetryEnabled(): boolean {
  if (process.env.ASTRIVYA_TELEMETRY === "off" || process.env.NO_TELEMETRY === "1") return false;
  if (isCI()) return false;
  return loadConfig().telemetry !== "off";
}

export function telemetryStatePath(): string {
  return getConfigPath("telemetry.json");
}

export function loadTelemetryState(): TelemetryState {
  if (_state) return _state;
  try {
    _state = JSON.parse(fs.readFileSync(telemetryStatePath(), "utf8")) as TelemetryState;
  } catch {
    _state = { installId: randomUUID() };
  }
  if (!_state.installId) _state.installId = randomUUID();
  return _state;
}

function persistTelemetryState(): void {
  if (!_state) return;
  try {
    fs.writeFileSync(telemetryStatePath(), JSON.stringify(_state, null, 2), "utf8");
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
 * Print the one-time opt-out disclosure to stderr. Persisted per install so it
 * only appears once. `skip` suppresses it (used for `astrivya config set`).
 */
export function maybePrintTelemetryBanner(skip = false): void {
  if (skip || !isTelemetryEnabled()) return;
  const state = loadTelemetryState();
  if (state.bannerShown) return;
  state.bannerShown = true;
  persistTelemetryState();
  console.error(
    color.dim(
      "\u203A Anonymous usage stats are enabled (no code, paths, or queries are ever sent). " +
        "Disable: astrivya config set telemetry off",
    ),
  );
}

/** Base properties attached to every event. */
export function baseTelemetryProps(): Record<string, string> {
  const os = require("node:os") as typeof import("node:os");
  return {
    install_id: getInstallId(),
    product: "cli",
    cli_version: CURRENT_VERSION,
    node_version: process.version,
    os_name: os.platform(),
    os_version: os.release(),
    arch: os.arch(),
  };
}

/**
 * Build the PostHog capture body. Exported for tests. Properties whose keys
 * are in `captureForbiddenKeys` are stripped here — the guard is structural,
 * not convention-based.
 */
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
  "arg",
  "commandArgs",
  "query",
  "content",
  "token",
  "secret",
  "key",
  "message",
  "stack",
  "error",
];

/**
 * Fire-and-forget anonymous event capture. Never throws, never blocks exit,
 * aborts after TIMEOUT_MS, swallows all failures.
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

let _commandName = "";
let _commandStartedAt = 0;

/** Record the start of a CLI command run (called from the commander preAction hook). */
export function beginCommandTelemetry(name: string): void {
  _commandName = name;
  _commandStartedAt = Date.now();
}

/** Emit the command-run event. Call on success (postAction) and on failure (main().catch). */
export function endCommandTelemetry(exit: "ok" | "error", errorType?: string): void {
  if (!_commandName) return;
  const name = _commandName;
  _commandName = "";
  capture("oss_cli_command", {
    command: name,
    duration_ms: Date.now() - _commandStartedAt,
    exit,
    ...(errorType ? { error_type: errorType } : {}),
  });
}
