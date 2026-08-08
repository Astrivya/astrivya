import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";

const paths = envPaths("astrivya", { suffix: "" });

export interface AppConfig {
  token?: string;
  baseUrl?: string;
  teamId?: string;
  orgId?: string;
  verbose?: boolean;
  offlineMode?: boolean;
  localAiProfile?: "lite" | "smart";
  ollamaUrl?: string;
  customModelPath?: string;
  debugLocalAi?: boolean;
  localAiRuntime?: string;
  localAiFallbacks?: string[];
  syncApiKey?: string;
}

let _verbose = false;
let _configCache: AppConfig | null = null;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

function configDir(): string {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return path.join(process.cwd(), ".config-test");
  }
  return paths.config;
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function ensureConfigDir(): void {
  const dir = configDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): AppConfig {
  if (_configCache) return _configCache;
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    _configCache = JSON.parse(raw) as AppConfig;
    return _configCache;
  } catch {
    _configCache = {};
    return _configCache;
  }
}

export function saveConfig(config: Partial<AppConfig>): void {
  ensureConfigDir();
  _configCache = { ..._configCache, ...config };
  fs.writeFileSync(configPath(), JSON.stringify(_configCache, null, 2), "utf-8");
}

export function clearConfig(): void {
  _configCache = null;
  try {
    fs.unlinkSync(configPath());
  } catch {
    // ignore if file doesn't exist
  }
}

export function clearConfigCache(): void {
  _configCache = null;
}
