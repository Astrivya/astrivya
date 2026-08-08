export { PluginManager } from "./plugin-manager";
export type { SyncResult } from "./plugin-manager";
export { ManifestClient } from "./manifest-client";
export type { ManifestClientOptions } from "./manifest-client";
export { PluginDownloader } from "./plugin-downloader";
export type { DownloaderOptions } from "./plugin-downloader";
export { PluginVerifier } from "./plugin-verifier";
export type { VerificationResult } from "./plugin-verifier";
export { PluginLoader } from "./plugin-loader";
export { PluginRegistry } from "./plugin-registry";

export type {
  PluginCapability,
  PluginState,
  PluginCompatibility,
  PluginMetadata,
  PluginEntry,
  RemoteManifest,
  DiscoverableCommand,
  CommandPlugin,
  ToolPlugin,
  LocalManifestEntry,
  LocalManifest,
} from "@astrivya/plugin-api";
