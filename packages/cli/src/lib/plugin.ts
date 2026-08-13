import type { CommandPlugin } from "@astrivya/plugin-api";
import { PluginManager } from "@astrivya/plugin-runtime";
import { getBaseUrl, getLicenseKey, getToken } from "./compat";

/**
 * Make the CLI's resolved runtime context visible to plugin code. Plugins are
 * separate packages that read auth from the environment (`ASTRIVYA_TOKEN`,
 * `ASTRIVYA_BASE_URL`, ...) — without this they would miss the config-file
 * token and fall back to their own (wrong) default base URL.
 */
export function injectPluginEnv(): void {
  if (!process.env.ASTRIVYA_BASE_URL) {
    process.env.ASTRIVYA_BASE_URL = getBaseUrl();
  }
  if (!process.env.ASTRIVYA_TOKEN) {
    const token = getToken();
    if (token) process.env.ASTRIVYA_TOKEN = token;
  }
  if (!process.env.ASTRIVYA_LICENSE_KEY) {
    const key = getLicenseKey();
    if (key) process.env.ASTRIVYA_LICENSE_KEY = key;
  }
}

export async function loadCommandPlugins(): Promise<CommandPlugin[]> {
  injectPluginEnv();
  try {
    const pm = new PluginManager();
    const commands = await pm.loadCommands();
    if (commands.length > 0) {
      console.error(`[Astrivya] Loaded ${commands.length} plugin command(s)`);
    }
    return commands;
  } catch {
    return [];
  }
}
