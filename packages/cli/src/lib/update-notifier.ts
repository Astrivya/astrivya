import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";
import { color, isPrintMode } from "./output";
import { CURRENT_VERSION } from "./version";

const NPM_PACKAGE = "@astrivya/cli";
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

export interface UpdateCache {
  lastChecked?: number;
  notifiedVersion?: string;
  disabled?: boolean;
}

const paths = envPaths("astrivya", { suffix: "" });
export const CACHE_FILE = path.join(paths.cache, "update.json");

export function semverCompare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export function readCache(file = CACHE_FILE): UpdateCache {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as UpdateCache;
  } catch {
    return {};
  }
}

export function writeCache(cache: UpdateCache, file = CACHE_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // Cache is best-effort; never let it break the CLI.
  }
}

export function isOptedOut(): boolean {
  if (process.env.CI) return true;
  if (process.env.NO_UPDATE_NOTIFIER) return true;
  return false;
}

export function shouldCheck(cache: UpdateCache, now = Date.now(), intervalMs = DEFAULT_INTERVAL_MS): boolean {
  if (cache.disabled) return false;
  if (isOptedOut()) return false;
  if (!cache.lastChecked) return true;
  return now - cache.lastChecked >= intervalMs;
}

export function setDisabled(disabled: boolean): void {
  const cache = readCache();
  cache.disabled = disabled;
  writeCache(cache);
}

export function clearNotifiedVersion(): void {
  const cache = readCache();
  cache.notifiedVersion = undefined;
  writeCache(cache);
}

export async function fetchLatestVersion(timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

// Pure: does this cache state warrant a fresh network check? (Whether a new
// version should actually be surfaced is decided by `evaluateUpdate`, which
// notifies at most once per version.)
export function shouldNotify(cache: UpdateCache, now = Date.now()): boolean {
  return shouldCheck(cache, now);
}

// Pure: given the latest published version, decide whether to notify and return
// the latest version if so. Updates cache state.
export function evaluateUpdate(
  cache: UpdateCache,
  latest: string | null,
  current = CURRENT_VERSION,
  now = Date.now(),
): string | null {
  if (!latest) {
    cache.lastChecked = now;
    return null;
  }
  if (semverCompare(latest, current) > 0 && latest !== cache.notifiedVersion) {
    cache.notifiedVersion = latest;
    cache.lastChecked = now;
    return latest;
  }
  cache.lastChecked = now;
  return null;
}

export type InstallManager = "npm" | "pnpm" | "yarn" | "bun" | "local" | "unknown";

export function detectInstallManager(scriptPath = process.argv[1] || ""): InstallManager {
  const override = process.env.ASTRIVYA_UPDATE_MANAGER;
  if (override === "npm" || override === "pnpm" || override === "yarn" || override === "bun") {
    return override;
  }
  const p = scriptPath.replace(/\\/g, "/").toLowerCase();
  if (p.includes(".bun/bin") || p.includes("/bun/bin")) return "bun";
  if (p.includes("/pnpm/global/") || p.includes(".pnpm/global/")) return "pnpm";
  if (p.includes("/.yarn/") || p.includes("/yarn/bin") || p.includes("/global/yarn")) return "yarn";
  if (
    p.includes("/npm/node_modules/") ||
    p.includes("/lib/node_modules/") ||
    p.includes("nvm") ||
    p.includes("/n/versions/")
  ) {
    return "npm";
  }
  if (p.includes("/node_modules/@astrivya/cli")) return "local";
  return "unknown";
}

export function buildInstallCommand(manager: InstallManager): string {
  switch (manager) {
    case "pnpm":
      return `pnpm add -g ${NPM_PACKAGE}`;
    case "yarn":
      return `yarn global add ${NPM_PACKAGE}`;
    case "bun":
      return `bun add -g ${NPM_PACKAGE}`;
    case "local":
      return `npm install ${NPM_PACKAGE}@latest`;
    default:
      return `npm install -g ${NPM_PACKAGE}`;
  }
}

export function formatBanner(current: string, latest: string, print = isPrintMode()): string {
  const dim = (s: string) => (print ? s : color.dim(s));
  const bold = (s: string) => (print ? s : color.bold(s));
  const cyan = (s: string) => (print ? s : color.cyan(s));
  return [
    dim("────────────────────────────────────────────"),
    `  ${cyan("astrivya")} update available  ${bold(current)} ${dim("→")} ${bold(cyan(latest))}`,
    `  Run \`${cyan("astrivya update")}\` to install — one command, nothing else to do.`,
    dim("────────────────────────────────────────────"),
  ].join("\n");
}

// Top-level entry used by the CLI at exit time. Safe to call; never throws.
// Persists cache so the once-per-version throttle survives across runs.
export async function checkForUpdates(
  file = CACHE_FILE,
  fetcher: () => Promise<string | null> = fetchLatestVersion,
): Promise<string | null> {
  try {
    const cache = readCache(file);
    if (!shouldNotify(cache)) return null;
    const latest = await fetcher();
    const result = evaluateUpdate(cache, latest);
    writeCache(cache, file);
    return result;
  } catch {
    return null;
  }
}
