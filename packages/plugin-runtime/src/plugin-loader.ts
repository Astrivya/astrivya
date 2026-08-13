import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandPlugin, LocalManifestEntry, PluginMetadata, ToolPlugin } from "@astrivya/plugin-api";

export class PluginLoader {
  async loadCommands(pluginsDir: string, entry: LocalManifestEntry): Promise<CommandPlugin[]> {
    const mod = await this.importModule(pluginsDir, entry.id);
    if (!mod) return [];
    const manifest = mod.commands ?? mod.default?.commands ?? [];
    return manifest as CommandPlugin[];
  }

  async loadTools(pluginsDir: string, entry: LocalManifestEntry): Promise<ToolPlugin[]> {
    const mod = await this.importModule(pluginsDir, entry.id);
    if (!mod) return [];
    const manifest = mod.tools ?? mod.default?.tools ?? [];
    return manifest as ToolPlugin[];
  }

  async loadMetadata(pluginsDir: string, pluginId: string): Promise<PluginMetadata | null> {
    const mod = await this.importModule(pluginsDir, pluginId);
    if (!mod) return null;
    return (mod.metadata ?? mod.default?.metadata ?? null) as PluginMetadata | null;
  }

  private async importModule(pluginsDir: string, pluginId: string): Promise<PluginModule | null> {
    const pluginDir = join(pluginsDir, pluginId);
    const mainJs = join(pluginDir, "index.js");

    if (!existsSync(mainJs)) {
      return null;
    }

    try {
      // `import()` of an absolute Windows path (C:\...) is rejected by the ESM
      // loader — it requires a file:// URL. Same on POSIX for paths with spaces.
      const mod = (await import(pathToFileURL(mainJs).href)) as PluginModule;
      return mod;
    } catch {
      return null;
    }
  }
}

interface PluginModule {
  commands?: CommandPlugin[];
  tools?: ToolPlugin[];
  metadata?: PluginMetadata;
  default?: PluginModule;
}
