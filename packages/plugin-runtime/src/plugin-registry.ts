import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoverableCommand, LocalManifest, LocalManifestEntry } from "@astrivya/plugin-api";

export class PluginRegistry {
  private manifestPath: string;
  private pluginsDir: string;

  constructor(baseDir: string) {
    this.pluginsDir = join(baseDir, "plugins");
    this.manifestPath = join(this.pluginsDir, "manifest.json");
  }

  getPluginsDir(): string {
    return this.pluginsDir;
  }

  ensureDir(): void {
    if (!existsSync(this.pluginsDir)) {
      mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  async readManifest(): Promise<LocalManifest> {
    try {
      const data = await readFile(this.manifestPath, "utf-8");
      return JSON.parse(data) as LocalManifest;
    } catch {
      return { installed: [] };
    }
  }

  async writeManifest(manifest: LocalManifest): Promise<void> {
    this.ensureDir();
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  async findEntry(pluginId: string): Promise<LocalManifestEntry | undefined> {
    const manifest = await this.readManifest();
    return manifest.installed.find((e) => e.id === pluginId);
  }

  async upsertEntry(entry: LocalManifestEntry): Promise<void> {
    const manifest = await this.readManifest();
    const idx = manifest.installed.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      manifest.installed[idx] = entry;
    } else {
      manifest.installed.push(entry);
    }
    await this.writeManifest(manifest);
  }

  async removeEntry(pluginId: string): Promise<void> {
    const manifest = await this.readManifest();
    manifest.installed = manifest.installed.filter((e) => e.id !== pluginId);
    await this.writeManifest(manifest);
  }

  async setDiscoverableCommands(commands: DiscoverableCommand[]): Promise<void> {
    const manifest = await this.readManifest();
    manifest.discoverableCommands = commands;
    await this.writeManifest(manifest);
  }

  async getDiscoverableCommands(): Promise<DiscoverableCommand[]> {
    const manifest = await this.readManifest();
    return manifest.discoverableCommands ?? [];
  }

  async clear(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    try {
      await rm(this.pluginsDir, { recursive: true, force: true });
    } catch {}
    this.ensureDir();
    await this.writeManifest({ installed: [] });
  }
}
