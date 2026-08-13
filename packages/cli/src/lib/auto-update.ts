import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { PluginManager } from "@astrivya/plugin-runtime";
import envPaths from "env-paths";
import { getBaseUrl, getPremiumAuth, loadConfig } from "./compat";
import { error, info, startSpinner, success } from "./output";
import {
  CACHE_FILE,
  type UpdateCache,
  buildInstallCommand,
  detectInstallManager,
  evaluateUpdate,
  fetchLatestVersion,
  formatBanner,
  isOptedOut,
  readCache,
  shouldCheck,
  writeCache,
} from "./update-notifier";
import { CURRENT_VERSION } from "./version";

const PROMPT_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const FAIL_BACKOFF_MS = 24 * 60 * 60 * 1000;
const PLUGIN_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

const paths = envPaths("astrivya", { suffix: "" });
export const PLUGIN_SYNC_FILE = path.join(paths.cache, "plugin-sync.json");

export type AutoUpdateMode = "on" | "prompt" | "off";

export function sameMajor(a: string, b: string): boolean {
  const major = (v: string) => Number(v.split(".")[0] || "0");
  return major(a) === major(b);
}

export function getUpdateMode(): AutoUpdateMode {
  const mode = loadConfig().autoUpdate;
  return mode === "on" || mode === "off" ? mode : "prompt";
}

// Pure: should an available update be installed without a prompt (or with a
// prompt, when the caller decides)? Never touches local/unknown installs,
// never crosses a major version, and backs off for a day after a failure.
export function shouldAutoInstall(
  cache: UpdateCache,
  latest: string,
  current: string,
  manager: ReturnType<typeof detectInstallManager>,
  now = Date.now(),
): boolean {
  if (manager === "local" || manager === "unknown") return false;
  if (!sameMajor(current, latest)) return false;
  if (cache.lastFailedAt && now - cache.lastFailedAt < FAIL_BACKOFF_MS) return false;
  return true;
}

export function markUpdateFailed(file = CACHE_FILE, now = Date.now()): void {
  const cache = readCache(file);
  cache.lastFailedAt = now;
  writeCache(cache, file);
}

export function markUpdateSucceeded(file = CACHE_FILE): void {
  const cache = readCache(file);
  cache.lastFailedAt = undefined;
  cache.notifiedVersion = undefined;
  writeCache(cache, file);
}

export function runInstall(cmd: string, file = CACHE_FILE): boolean {
  const spinner = startSpinner("Installing the latest astrivya\u2026");
  try {
    execSync(cmd, { stdio: "pipe", encoding: "utf8", timeout: INSTALL_TIMEOUT_MS });
    spinner.succeed();
    markUpdateSucceeded(file);
    success("Updated to the latest version. Next command uses the new version.");
    return true;
  } catch (err: unknown) {
    spinner.fail();
    markUpdateFailed(file);
    error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    info(`You can also run it manually: ${cmd}`);
    return false;
  }
}

export async function askYesNo(question: string, timeoutMs = PROMPT_TIMEOUT_MS): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const answer = await rl.question(question, { signal: ac.signal });
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

// Called at the start of every command (except the update command itself).
// Checks the registry once per day; when a newer same-major version exists:
//   - "on"     -> installs silently
//   - "prompt" -> asks the user (TTY only) and installs on "y"
//   - "off"    -> prints the banner only
// Never throws; never blocks longer than the fetch/prompt/install timeouts.
export async function maybeAutoUpdate(
  opts: {
    noUpdateCheck?: boolean;
    skipInstall?: boolean;
    fetcher?: () => Promise<string | null>;
    installer?: (cmd: string) => boolean;
  } = {},
  file = CACHE_FILE,
): Promise<void> {
  if (opts.noUpdateCheck) return;
  if (isOptedOut()) return;
  const cache = readCache(file);
  if (!shouldCheck(cache)) return;
  const latest = await (opts.fetcher ?? fetchLatestVersion)();
  const result = evaluateUpdate(cache, latest);
  writeCache(cache, file);
  if (!result) return;

  const printBanner = () => console.log(`\n${formatBanner(CURRENT_VERSION, result)}\n`);
  if (opts.skipInstall || getUpdateMode() === "off") {
    printBanner();
    return;
  }
  const manager = detectInstallManager();
  if (!shouldAutoInstall(cache, result, CURRENT_VERSION, manager)) {
    printBanner();
    return;
  }
  const cmd = buildInstallCommand(manager);
  const installer = opts.installer ?? runInstall;
  if (getUpdateMode() === "on") {
    installer(cmd);
    return;
  }
  if (!process.stdin.isTTY) {
    printBanner();
    return;
  }
  const yes = await askYesNo(`Update ${CURRENT_VERSION} \u2192 ${result} now? [y/N] `);
  if (!yes) {
    info("Skipped. Run `astrivya update` anytime.");
    return;
  }
  installer(cmd);
}

export interface PluginSyncCache {
  lastSync?: number;
}

export function readPluginSyncCache(file = PLUGIN_SYNC_FILE): PluginSyncCache {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PluginSyncCache;
  } catch {
    return {};
  }
}

export function shouldSyncPlugins(cache: PluginSyncCache, now = Date.now()): boolean {
  if (!cache.lastSync) return true;
  return now - cache.lastSync >= PLUGIN_SYNC_INTERVAL_MS;
}

// Silent plugin auto-sync: runs ~once per day after commands when the user is
// authenticated. sha256-verified on the plugin-runtime side; only prints when
// something changed or failed. Best-effort — never crashes the CLI.
export async function maybeSyncPlugins(opts: { local?: boolean } = {}, file = PLUGIN_SYNC_FILE): Promise<void> {
  if (opts.local) return;
  if (isOptedOut()) return;
  const token = getPremiumAuth();
  if (!token) return;
  const cache = readPluginSyncCache(file);
  if (!shouldSyncPlugins(cache)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastSync: Date.now() }, null, 2), "utf8");
  } catch {
    return;
  }
  try {
    const pm = new PluginManager(undefined, getBaseUrl());
    const result = await pm.sync(token);
    if (result.updated.length > 0) {
      console.log(`  \u2191 Auto-updated plugins: ${result.updated.join(", ")}`);
    }
    if (result.failed.length > 0) {
      console.log(`  \u2717 Plugin auto-sync failed: ${result.failed.map((f) => `${f.id} (${f.error})`).join(", ")}`);
    }
  } catch {
    // best-effort — a transient network/auth failure is not an error to surface
  }
}
