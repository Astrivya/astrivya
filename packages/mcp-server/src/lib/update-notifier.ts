import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";
import { CURRENT_VERSION } from "./version";

const NPM_PACKAGE = "@astrivya/mcp-server";
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

export interface UpdateCache {
  lastChecked?: number;
  notifiedVersion?: string;
}

const paths = envPaths("astrivya-mcp", { suffix: "" });
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
    // Cache is best-effort; never let it break the server.
  }
}

export function isOptedOut(): boolean {
  if (process.env.CI) return true;
  if (process.env.NO_UPDATE_NOTIFIER) return true;
  if (process.env.ASTRIVYA_MCP_NO_UPDATE_CHECK) return true;
  return false;
}

export function shouldCheck(cache: UpdateCache, now = Date.now(), intervalMs = DEFAULT_INTERVAL_MS): boolean {
  if (isOptedOut()) return false;
  if (!cache.lastChecked) return true;
  return now - cache.lastChecked >= intervalMs;
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

// Pure: decide whether to surface `latest`. Notifies at most once per version.
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

export function formatBanner(current: string, latest: string): string {
  return [
    "",
    `  [Astrivya MCP] Update available: ${current} → ${latest}`,
    `  [Astrivya MCP] Run \`npm i -g ${NPM_PACKAGE}@latest\` to update.`,
    "",
  ].join("\n");
}

// Non-blocking, never throws. Returns the new version when one should be shown.
export async function checkForUpdates(
  file = CACHE_FILE,
  fetcher: () => Promise<string | null> = fetchLatestVersion,
): Promise<string | null> {
  try {
    const cache = readCache(file);
    if (!shouldCheck(cache)) return null;
    const latest = await fetcher();
    const result = evaluateUpdate(cache, latest);
    writeCache(cache, file);
    return result;
  } catch {
    return null;
  }
}
