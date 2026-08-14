import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";
import {
  CACHE_FILE,
  checkForUpdates,
  fetchLatestVersion,
  formatBanner,
  isOptedOut,
  readCache,
  semverCompare,
  shouldCheck,
  writeCache,
} from "./update-notifier";
import { CURRENT_VERSION } from "./version";

const FAIL_BACKOFF_MS = 24 * 60 * 60 * 1000;

const paths = envPaths("astrivya-mcp", { suffix: "" });
export const AUTO_UPDATE_FILE = path.join(paths.cache, "auto-update.json");

export interface AutoUpdateState {
  /** Version being installed in the background; verified on the next startup. */
  pending?: string;
  lastFailedAt?: number;
}

export function readState(file = AUTO_UPDATE_FILE): AutoUpdateState {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as AutoUpdateState;
  } catch {
    return {};
  }
}

export function writeState(state: AutoUpdateState, file = AUTO_UPDATE_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort — never break the server
  }
}

export function isAutoUpdateEnabled(): boolean {
  return process.env.ASTRIVYA_MCP_AUTO_UPDATE === "1";
}

export function sameMajor(a: string, b: string): boolean {
  const major = (v: string) => Number(v.split(".")[0] || "0");
  return major(a) === major(b);
}

// Only global installs can be safely replaced in place. npx cache (`_npx`)
// installs and local project installs must never be touched.
export function isGlobalInstall(scriptPath = process.argv[1] || ""): boolean {
  const p = scriptPath.replace(/\\/g, "/").toLowerCase();
  if (p.includes("_npx")) return false;
  return (
    p.includes("/lib/node_modules/@astrivya/mcp-server") ||
    p.includes("/appdata/roaming/npm/node_modules/@astrivya/mcp-server") ||
    p.includes(".pnpm/global") ||
    p.includes("/pnpm/global/") ||
    p.includes("/.bun/install/global/")
  );
}

// Pure: did the running code reach the pending target version?
export function verifyPendingUpdate(state: AutoUpdateState, current: string): { updated: boolean; target?: string } {
  if (!state.pending) return { updated: false };
  if (semverCompare(current, state.pending) >= 0) return { updated: true, target: state.pending };
  return { updated: false };
}

export function spawnBackgroundInstall(version: string): void {
  try {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(cmd, ["install", "-g", "@astrivya/mcp-server@latest"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // ignored — the pending marker is cleared/flagged on the next startup
  }
}

// Non-blocking. Falls back to the banner when auto-update is not enabled.
// When enabled (ASTRIVYA_MCP_AUTO_UPDATE=1) and the install is a global npm
// install, newer same-major versions are installed in the background; the
// running process keeps its loaded code and the new version takes effect on
// the next client launch.
export async function maybeAutoUpdate(): Promise<void> {
  const state = readState();

  if (state.pending) {
    const res = verifyPendingUpdate(state, CURRENT_VERSION);
    if (res.updated) {
      console.error(`[Astrivya MCP] Updated to ${res.target} \u2014 restart your MCP client session to use it.`);
      writeState({ ...state, pending: undefined });
    } else {
      console.error(`[Astrivya MCP] Background update to ${state.pending} did not complete.`);
      writeState({ ...state, pending: undefined, lastFailedAt: Date.now() });
    }
  }

  if (isOptedOut()) return;

  if (!isAutoUpdateEnabled()) {
    const latest = await checkForUpdates();
    if (latest) console.error(formatBanner(CURRENT_VERSION, latest));
    return;
  }

  const cache = readCache();
  if (!shouldCheck(cache)) return;
  const latest = await fetchLatestVersion();
  writeCache({ ...cache, lastChecked: Date.now() });
  if (!latest || semverCompare(latest, CURRENT_VERSION) <= 0) return;

  if (!sameMajor(CURRENT_VERSION, latest)) {
    console.error(formatBanner(CURRENT_VERSION, latest));
    return;
  }
  const fresh = readState();
  if (fresh.lastFailedAt && Date.now() - fresh.lastFailedAt < FAIL_BACKOFF_MS) return;
  if (!isGlobalInstall()) return;

  spawnBackgroundInstall(latest);
  writeState({ ...fresh, pending: latest });
  console.error(
    `[Astrivya MCP] Updating to ${latest} in the background \u2014 restart your MCP client session to use it.`,
  );
}
