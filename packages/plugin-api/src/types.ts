export type PluginCapability = "cli" | "mcp";

export type PluginState = "downloading" | "installed" | "verified" | "corrupted" | "disabled" | "update-available";

export interface PluginCompatibility {
  cli?: string;
  runtime?: string;
  api?: string;
}

export interface CommandDescriptor {
  name: string;
  description: string;
  aliases?: string[];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  homepage?: string;
  license?: string;
  capabilities: PluginCapability[];
  compatibility: PluginCompatibility;
  permissions?: string[];
  commands?: CommandDescriptor[];
  tools?: ToolDescriptor[];
}

export interface PluginEntry {
  id: string;
  version: string;
  sha256: string;
  url: string;
  capabilities: PluginCapability[];
  compatibility: PluginCompatibility;
  metadata?: PluginMetadata;
}

export interface RemoteManifest {
  plugins: PluginEntry[];
  discoverableCommands: DiscoverableCommand[];
}

export interface DiscoverableCommand {
  name: string;
  description: string;
  aliases?: string[];
  pluginId: string;
  pluginName?: string;
}

export interface CommandPlugin {
  name: string;
  description: string;
  register(program: unknown): void;
}

export interface ToolPlugin {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(args: unknown): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

export interface LocalManifestEntry {
  id: string;
  version: string;
  state: PluginState;
  sha256: string;
  installedAt: string;
  capabilities: PluginCapability[];
  compatibility: PluginCompatibility;
}

export interface LocalManifest {
  installed: LocalManifestEntry[];
  discoverableCommands?: DiscoverableCommand[];
}
