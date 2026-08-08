import type { CommandPlugin } from "@astrivya/plugin-api";
import { PluginManager } from "@astrivya/plugin-runtime";

export async function loadCommandPlugins(): Promise<CommandPlugin[]> {
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
