import type { ToolPlugin } from "@astrivya/plugin-api";
import { PluginManager } from "@astrivya/plugin-runtime";
export type { ToolPlugin };

export async function loadToolPlugins(): Promise<ToolPlugin[]> {
  try {
    const pm = new PluginManager();
    const tools = await pm.loadTools();
    if (tools.length > 0) {
      console.error(`[Astrivya MCP] Loaded ${tools.length} tool(s) from plugins`);
    }
    return tools;
  } catch {
    return [];
  }
}
