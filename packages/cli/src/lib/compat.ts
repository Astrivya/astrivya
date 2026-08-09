// OSS CLI compatibility layer — replaces @astrivya/toolkit imports
import type { Command } from "commander";
import { ensureConfigDir, getConfigPath, isVerbose, setVerbose } from "./config";
import { color, getErrorMessage } from "./output";

export { setVerbose, isVerbose, ensureConfigDir, getErrorMessage };

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AppConfig {
  token?: string;
  baseUrl?: string;
  orgId?: string;
  teamId?: string;
  verbose?: boolean;
  offlineMode?: boolean;
  localAiProfile?: string;
  localAiRuntime?: string;
  localAiFallbacks?: string[];
  ollamaUrl?: string;
  customModelPath?: string;
  syncApiKey?: string;
  licenseKey?: string;
  teamMcpId?: string;
  role?: string;
  teamName?: string;
}

let _configCache: AppConfig | null = null;

function configPath(): string {
  return getConfigPath("config.json");
}

export function loadConfig(): AppConfig {
  if (_configCache) return _configCache;
  try {
    const fs = require("node:fs");
    const raw = fs.readFileSync(configPath(), "utf-8");
    _configCache = JSON.parse(raw) as AppConfig;
    return _configCache;
  } catch {
    _configCache = {};
    return _configCache;
  }
}

export function saveConfig(config: Partial<AppConfig>): void {
  const fs = require("node:fs");
  _configCache = { ..._configCache, ...config };
  fs.writeFileSync(configPath(), JSON.stringify(_configCache, null, 2), "utf-8");
}

export function clearConfig(): void {
  _configCache = null;
  try {
    const fs = require("node:fs");
    fs.unlinkSync(configPath());
  } catch {}
}

export function getToken(): string | undefined {
  return process.env.ASTRIVYA_TOKEN || process.env.ASTRIVYA_API_KEY || loadConfig().token;
}

export function getLicenseKey(): string | undefined {
  return process.env.ASTRIVYA_LICENSE_KEY || loadConfig().licenseKey;
}

export function saveLicenseKey(key: string): void {
  saveConfig({ licenseKey: key });
}

export function clearLicenseKey(): void {
  saveConfig({ licenseKey: undefined });
}

export function getLicenseStatusConfig(): { licenseKey: string | undefined } {
  return { licenseKey: getLicenseKey() };
}

/**
 * Credential for cloud-premium endpoints (plugin manifest + artifact
 * download). Prefers the license key when present — it is the payment-path
 * credential that the server tier-gates against. Falls back to the auth token.
 */
export function getPremiumAuth(): string | undefined {
  return getLicenseKey() || getToken();
}

export function getBaseUrl(): string {
  return process.env.ASTRIVYA_BASE_URL || loadConfig().baseUrl || "https://www.astrivya.ai";
}

export function getOrgId(): string | undefined {
  return process.env.ASTRIVYA_ORG_ID || loadConfig().orgId;
}

export async function apiCall(
  endpoint: string,
  _method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  _body?: any,
): Promise<any> {
  const token = getToken();
  const baseUrl = getBaseUrl();

  if (!token) {
    const msg = "Cloud API not configured. Set ASTRIVYA_TOKEN or run `astrivya setup`.";
    if (isVerbose()) console.error(color.dim(`[apiCall] ${msg}`));
    throw new ApiError(msg, 401);
  }

  const url = `${baseUrl}${endpoint}`;
  const res = await fetch(url, {
    method: _method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(_body ? { body: JSON.stringify(_body) } : {}),
  });

  if (res.status === 401) {
    throw new ApiError(`Unauthorized (401) when calling Astrivya API at ${url}. Check your token.`, 401);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new ApiError(`API call failed with status ${res.status}: ${errText}`, res.status);
  }

  return await res.json();
}

export function clearConfigCache(): void {
  _configCache = null;
}

export async function findFreePort(startPort = 3000): Promise<number> {
  const net = require("node:net");
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, () => {
          server.close();
          resolve();
        });
      });
      return port;
    } catch {}
  }
  throw new Error("No free port found");
}

export async function startOAuthServer(
  port: number,
  _timeout?: number,
): Promise<{ server: any; tokenPromise: Promise<string>; token?: string; profile?: { email?: string } }> {
  const http = require("node:http");
  const url = require("node:url");

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req: any, res: any) => {
      const parsed = url.parse(req.url || "", true);
      if (parsed.pathname === "/callback" && parsed.query.token) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authenticated!</h1><p>You may close this window.</p></body></html>");
        server.close();
        resolve({ server, tokenPromise: Promise.resolve(parsed.query.token as string) });
      }
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      }
    });

    server.listen(port, () => {
      console.error(`OAuth server listening on http://localhost:${port}/callback`);
    });

    server.on("error", reject);
  });
}

export function registerWithProgram<T>(
  program: Command,
  name: string,
  description: string,
  fn: (...args: any[]) => Promise<T>,
): void {
  program
    .command(name)
    .description(description)
    .action(async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (err: unknown) {
        console.error(`${color.red("Error:")} ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
