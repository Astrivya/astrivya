import { join } from "node:path";
import type {
  CommandPlugin,
  DiscoverableCommand,
  LocalManifestEntry,
  PluginMetadata,
  ToolPlugin,
} from "@astrivya/plugin-api";
import { ManifestClient } from "./manifest-client";
import { PluginDownloader } from "./plugin-downloader";
import { PluginLoader } from "./plugin-loader";
import { PluginRegistry } from "./plugin-registry";
import { PluginVerifier, type VerificationResult } from "./plugin-verifier";

export interface SyncResult {
  synced: string[];
  failed: Array<{ id: string; error: string }>;
  updated: string[];
  removed: string[];
  discoverableCommands: DiscoverableCommand[];
}

const CLOUD_URL = process.env.ASTRIVYA_CLOUD_URL || "https://api.astrivya.ai";

export class PluginManager {
  private registry: PluginRegistry;
  private loader: PluginLoader;
  private verifier: PluginVerifier;
  private downloader: PluginDownloader;
  private manifestClient: ManifestClient;
  private cloudUrl: string;

  constructor(baseDir?: string, cloudUrl?: string) {
    const actualBaseDir = baseDir ?? getDefaultBaseDir();
    this.cloudUrl = (cloudUrl ?? CLOUD_URL).replace(/\/+$/, "");
    this.registry = new PluginRegistry(actualBaseDir);
    this.loader = new PluginLoader();
    this.verifier = new PluginVerifier();
    this.downloader = new PluginDownloader();
    this.manifestClient = new ManifestClient({ cloudUrl: this.cloudUrl });
  }

  async sync(token: string): Promise<SyncResult> {
    const result: SyncResult = {
      synced: [],
      failed: [],
      updated: [],
      removed: [],
      discoverableCommands: [],
    };

    this.registry.ensureDir();

    let remoteManifest;
    try {
      remoteManifest = await this.manifestClient.fetchManifest(token);
    } catch (err) {
      throw new Error(`Failed to fetch plugin manifest: ${err instanceof Error ? err.message : String(err)}`);
    }

    result.discoverableCommands = remoteManifest.discoverableCommands ?? [];

    await this.registry.setDiscoverableCommands(result.discoverableCommands);

    const localManifest = await this.registry.readManifest();
    const localMap = new Map(localManifest.installed.map((e) => [e.id, e]));

    for (const remotePlugin of remoteManifest.plugins) {
      const local = localMap.get(remotePlugin.id);
      const isUpdate = local && local.version !== remotePlugin.version;

      if (local && local.version === remotePlugin.version) {
        continue;
      }

      const pluginDir = join(this.registry.getPluginsDir(), remotePlugin.id);

      try {
        const downloadUrl = remotePlugin.url.startsWith("http")
          ? remotePlugin.url
          : `${this.cloudUrl}${remotePlugin.url}`;

        await this.downloader.download(downloadUrl, pluginDir, remotePlugin.sha256, token);

        // record the post-install tree hash (not the .tgz blob hash) as the
        // local baseline for `verify()` corruption detection
        const localSha256 = await this.downloader.computeTreeHash(pluginDir);

        const entry: LocalManifestEntry = {
          id: remotePlugin.id,
          version: remotePlugin.version,
          state: "verified",
          sha256: localSha256,
          installedAt: new Date().toISOString(),
          capabilities: remotePlugin.capabilities,
          compatibility: remotePlugin.compatibility,
        };
        await this.registry.upsertEntry(entry);

        if (isUpdate) {
          result.updated.push(remotePlugin.id);
        } else {
          result.synced.push(remotePlugin.id);
        }
      } catch (err) {
        result.failed.push({
          id: remotePlugin.id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (local) {
          await this.registry.upsertEntry({
            ...local,
            state: "corrupted",
          });
        }
      }
    }

    for (const [id, local] of localMap) {
      const stillExists = remoteManifest.plugins.some((p) => p.id === id);
      if (!stillExists && local.state !== "disabled") {
        await this.registry.upsertEntry({ ...local, state: "disabled" });
        result.removed.push(id);
      }
    }

    return result;
  }

  async loadCommands(): Promise<CommandPlugin[]> {
    const manifest = await this.registry.readManifest();

    const results: CommandPlugin[] = [];
    for (const entry of manifest.installed) {
      if (entry.state === "disabled" || entry.state === "corrupted") {
        continue;
      }
      if (!entry.capabilities.includes("cli")) {
        continue;
      }
      const commands = await this.loader.loadCommands(this.registry.getPluginsDir(), entry);
      results.push(...commands);
    }
    return results;
  }

  async loadTools(): Promise<ToolPlugin[]> {
    const manifest = await this.registry.readManifest();

    const results: ToolPlugin[] = [];
    for (const entry of manifest.installed) {
      if (entry.state === "disabled" || entry.state === "corrupted") {
        continue;
      }
      if (!entry.capabilities.includes("mcp")) {
        continue;
      }
      const tools = await this.loader.loadTools(this.registry.getPluginsDir(), entry);
      results.push(...tools);
    }
    return results;
  }

  async loadMetadata(pluginId: string): Promise<PluginMetadata | null> {
    const manifest = await this.registry.readManifest();
    const entry = manifest.installed.find((e) => e.id === pluginId);
    if (!entry) return null;
    if (entry.state === "disabled" || entry.state === "corrupted") {
      return null;
    }
    return this.loader.loadMetadata(this.registry.getPluginsDir(), pluginId);
  }

  async verify(): Promise<VerificationResult> {
    const manifest = await this.registry.readManifest();
    const result = await this.verifier.verifyAll(this.registry.getPluginsDir(), manifest.installed);

    for (const entry of result.entries) {
      await this.registry.upsertEntry({
        id: entry.id,
        version: "",
        state: entry.state,
        sha256: "",
        installedAt: new Date().toISOString(),
        capabilities: [],
        compatibility: {},
      });
    }

    return result;
  }

  async list(): Promise<LocalManifestEntry[]> {
    const manifest = await this.registry.readManifest();
    return manifest.installed;
  }

  async update(pluginId: string, token: string): Promise<void> {
    const remoteManifest = await this.manifestClient.fetchManifest(token);
    const remote = remoteManifest.plugins.find((p) => p.id === pluginId);
    if (!remote) {
      throw new Error(`Plugin "${pluginId}" not found in manifest`);
    }

    const pluginDir = join(this.registry.getPluginsDir(), remote.id);

    const downloadUrl = remote.url.startsWith("http") ? remote.url : `${this.cloudUrl}${remote.url}`;

    await this.downloader.download(downloadUrl, pluginDir, remote.sha256, token);

    const localSha256 = await this.downloader.computeTreeHash(pluginDir);

    const entry: LocalManifestEntry = {
      id: remote.id,
      version: remote.version,
      state: "verified",
      sha256: localSha256,
      installedAt: new Date().toISOString(),
      capabilities: remote.capabilities,
      compatibility: remote.compatibility,
    };
    await this.registry.upsertEntry(entry);
  }

  async getDiscoverableCommands(): Promise<DiscoverableCommand[]> {
    return this.registry.getDiscoverableCommands();
  }

  async clear(): Promise<void> {
    await this.registry.clear();
  }
}

function getDefaultBaseDir(): string {
  const { homedir } = require("node:os");
  const { join } = require("node:path");
  return join(homedir(), ".astrivya");
}
