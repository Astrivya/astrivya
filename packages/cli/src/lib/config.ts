// OSS CLI config utilities
import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";

let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

export function ensureConfigDir(): string {
  const paths = envPaths("astrivya", { suffix: "" });
  const configDir = paths.config;
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

export function getConfigPath(...segments: string[]): string {
  const base = ensureConfigDir();
  return path.join(base, ...segments);
}
