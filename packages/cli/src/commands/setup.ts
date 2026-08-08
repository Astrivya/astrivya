import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { confirm, input } from "@inquirer/prompts";
import type { Command } from "commander";
import { getBaseUrl, getToken, saveConfig } from "../lib/compat";
import { color, dim, error, getErrorMessage, info, startSpinner, success } from "../lib/output";

interface McpConfigEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface ToolDetector {
  name: string;
  detect(): boolean;
  configPath(): string;
  readConfig(): Record<string, unknown>;
  writeConfig(config: Record<string, unknown>): void;
}

// â”€â”€ Claude Code â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const claudeCode: ToolDetector = {
  name: "Claude Code",
  detect: () => {
    try {
      execSync("which claude", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  configPath: () => path.join(process.cwd(), ".claude", "settings.local.json"),
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(process.cwd(), ".claude", "settings.local.json"), "utf-8"));
    } catch {
      return {};
    }
  },
  writeConfig: (config) => {
    const dir = path.join(process.cwd(), ".claude");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify(config, null, 2), "utf-8");
  },
};

// â”€â”€ Cursor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const cursor: ToolDetector = {
  name: "Cursor",
  detect: () => {
    const possible = [path.join(os.homedir(), ".cursor", "mcp.json"), path.join(process.cwd(), ".cursor", "mcp.json")];
    return possible.some((p) => fs.existsSync(p));
  },
  configPath: () => {
    const local = path.join(process.cwd(), ".cursor", "mcp.json");
    if (fs.existsSync(local)) return local;
    return path.join(os.homedir(), ".cursor", "mcp.json");
  },
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(cursor.configPath(), "utf-8"));
    } catch {
      return {};
    }
  },
  writeConfig: (config) => {
    const p = cursor.configPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), "utf-8");
  },
};

// â”€â”€ OpenCode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const opencode: ToolDetector = {
  name: "OpenCode",
  detect: () => {
    try {
      execSync("which opencode", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  configPath: () => path.join(process.cwd(), "opencode.json"),
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(process.cwd(), "opencode.json"), "utf-8"));
    } catch {
      return {};
    }
  },
  writeConfig: (config) => {
    fs.writeFileSync(path.join(process.cwd(), "opencode.json"), JSON.stringify(config, null, 2), "utf-8");
  },
};

// â”€â”€ Claude Desktop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function claudeDesktopConfigDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Claude");
  }
  return path.join(os.homedir(), ".config", "Claude");
}

const claudeDesktop: ToolDetector = {
  name: "Claude Desktop",
  detect: () => fs.existsSync(claudeDesktopConfigDir()),
  configPath: () => path.join(claudeDesktopConfigDir(), "claude_desktop_config.json"),
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(claudeDesktop.configPath(), "utf-8"));
    } catch {
      return {};
    }
  },
  writeConfig: (config) => {
    const dir = claudeDesktopConfigDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(claudeDesktop.configPath(), JSON.stringify(config, null, 2), "utf-8");
  },
};

// â”€â”€ Windsurf â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const windsurf: ToolDetector = {
  name: "Windsurf",
  detect: () => {
    const p = path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
    return fs.existsSync(p);
  },
  configPath: () => path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"), "utf-8"));
    } catch {
      return {};
    }
  },
  writeConfig: (config) => {
    const dir = path.join(os.homedir(), ".codeium", "windsurf");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mcp_config.json"), JSON.stringify(config, null, 2), "utf-8");
  },
};

const ALL_TOOLS = [claudeCode, cursor, opencode, claudeDesktop, windsurf];

function buildMcpServiceEntry(apiUrl: string, provider?: string, apiKey?: string): McpConfigEntry {
  const env: Record<string, string> = {
    ASTRIVYA_BASE_URL: apiUrl,
    ASTRIVYA_TOKEN: "${ASTRIVYA_TOKEN}",
  };
  if (provider && apiKey) {
    const keyVar = provider === "anthropic" ? "ASTRIVYA_ANTHROPIC_KEY" : "ASTRIVYA_OPENAI_KEY";
    env[keyVar] = apiKey;
  }
  return { command: "npx", args: ["-y", "@astrivya/mcp-server"], env };
}

function buildOpenCodeEntry(apiUrl: string, provider?: string, apiKey?: string): Record<string, unknown> {
  const environment: Record<string, string> = {
    ASTRIVYA_BASE_URL: apiUrl,
    ASTRIVYA_TOKEN: "{env:ASTRIVYA_TOKEN}",
  };
  if (provider && apiKey) {
    const keyVar = provider === "anthropic" ? "ASTRIVYA_ANTHROPIC_KEY" : "ASTRIVYA_OPENAI_KEY";
    environment[keyVar] = apiKey;
  }
  return {
    type: "local",
    command: ["npx", "-y", "@astrivya/mcp-server"],
    enabled: true,
    environment,
  };
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Auto-configure Astrivya MCP across all supported tools")
    .option("-t, --token <token>", "ASTRIVYA_TOKEN to use")
    .option("-u, --base-url <url>", "Astrivya backend URL")
    .option("--tools <names>", "Comma-separated tool list (default: all detected)")
    .option("--dry-run", "Show what would be configured without writing")
    .option("-i, --interactive", "Force interactive mode")
    .option("-d, --detect", "Auto-detect tools and configure without prompting")
    .option("--provider <name>", "AI provider for BYOK (openai, anthropic)")
    .option("--api-key <key>", "API key for BYOK provider")
    .action(async (options) => {
      try {
        let apiUrl = options.baseUrl || getBaseUrl();
        const token = options.token || getToken();
        const provider = options.provider;
        const apiKey = options.apiKey;

        if (provider && !apiKey) {
          error("--api-key is required when using --provider");
          process.exit(1);
        }
        if (apiKey && !provider) {
          error("--provider is required when using --api-key");
          process.exit(1);
        }

        // Interactive mode when no flags provided or --interactive is set
        const hasActionFlags = options.token || options.baseUrl || options.tools || options.dryRun || options.detect;
        if (!hasActionFlags) {
          options.interactive = true;
        }

        if (options.interactive) {
          console.log(`\n${color.bold("Astrivya Setup Wizard")}\n`);

          if (!token) {
            const wantsLogin = await confirm({
              message: "You're not authenticated. Log in now?",
              default: true,
            });
            if (wantsLogin) {
              console.log(
                `  Run ${color.cyan("`astrivya auth login`")} then ${color.cyan("`astrivya setup`")} again.\n`,
              );
              process.exit(0);
            }
          }

          const customUrl = await confirm({
            message: `Use default API URL (${apiUrl})?`,
            default: true,
          });
          if (!customUrl) {
            apiUrl = await input({
              message: "Astrivya API URL:",
              default: apiUrl,
              validate: (val) => val.length > 0 || "URL is required",
            });
          }

          // Save settings
          saveConfig({ token, baseUrl: apiUrl });
          success("Configuration saved.");
        }

        if (!token && !options.detect) {
          error("No token found. Run `astrivya auth login` first, pass --token, or use --detect for local-only setup.");
          process.exit(1);
        }

        // Save config
        saveConfig({ token, baseUrl: apiUrl });

        // Determine which tools to configure
        const toolFilter = options.tools ? options.tools.split(",").map((t: string) => t.trim().toLowerCase()) : null;

        const toConfigure = toolFilter ? ALL_TOOLS.filter((t) => toolFilter.includes(t.name.toLowerCase())) : ALL_TOOLS;

        if (toConfigure.length === 0) {
          info("No supported tools detected or specified.");
          return;
        }

        // Detect mode: show detected tools and configure all detected ones
        if (options.detect) {
          console.log(`\n${color.bold("Detecting tools...")}\n`);
          const detected: string[] = [];
          for (const tool of toConfigure) {
            const found = tool.detect();
            const icon = found ? color.green("\u2713") : dim("\u25CB");
            console.log(`  ${icon} ${tool.name}`);
            if (found) detected.push(tool.name);
          }

          if (detected.length === 0) {
            console.log(`\n${dim("No supported tools detected.")}\n`);
            return;
          }

          if (options.dryRun) {
            console.log(
              `\n${dim(`Detected ${detected.length} tool(s). Pass --dry-run without --detect to see config paths.`)}\n`,
            );
            return;
          }

          const detectedTools = toConfigure.filter((t) => t.detect());
          if (detectedTools.length === 0) {
            console.log(`\n${info("No detected tools to configure.")}\n`);
            return;
          }

          const spinner = startSpinner(`Configuring ${detectedTools.length} tool(s)...`);
          let configured = 0;
          let skipped = 0;

          for (const tool of detectedTools) {
            try {
              const existing = tool.readConfig();

              if (tool.name === "OpenCode") {
                const mcpSection = (existing as any).mcp || {};
                mcpSection.astrivya = buildOpenCodeEntry(apiUrl, provider, apiKey);
                (existing as any).mcp = mcpSection;
              } else {
                const servers = (existing as any).mcpServers || {};
                servers.astrivya = buildMcpServiceEntry(apiUrl, provider, apiKey);
                (existing as any).mcpServers = servers;
              }

              tool.writeConfig(existing);
              configured++;
            } catch (err: unknown) {
              skipped++;
              spinner.stop();
              console.log(`  ${color.red("\u2717")} ${tool.name} \u2014 ${getErrorMessage(err)}`);
              spinner.start();
            }
          }

          spinner.stop();
          console.log();
          success(`${configured} configured, ${skipped} skipped.`);

          if (configured > 0 && !token) {
            if (provider && apiKey) {
              console.log(`\n  ${dim("Configured with BYOK provider:")} ${color.cyan(provider)}`);
              console.log(`  ${dim("Local AI features will use your API key.")}`);
            } else {
              console.log(`\n  ${dim("Running in local mode. Cloud features require ASTRIVYA_TOKEN.")}`);
            }
            console.log();
          }

          if (configured > 0 && token) {
            console.log(`\n  Set ${color.cyan("ASTRIVYA_TOKEN")} in your shell:\n`);
            console.log(`    export ASTRIVYA_TOKEN="${token}"`);
            console.log();
            console.log(`  Next: ${color.cyan("astrivya doctor")} to verify your setup.`);
            console.log(`  Then install the VS Code extension: ${dim("https://astrivya.ai/extension")}\n`);
          }
          return;
        }

        // Regular mode (non-detect)
        if (options.dryRun) {
          console.log(`\n${dim(`Would configure ${toConfigure.length} tool(s):`)}\n`);
          for (const tool of toConfigure) {
            const detected = tool.detect();
            console.log(`  ${detected ? color.green("\u2713") : dim("\u25CB")} ${tool.name}`);
            console.log(`    Config: ${dim(tool.configPath())}`);
          }
          console.log();
          return;
        }

        const spinner = startSpinner(`Configuring ${toConfigure.length} tool(s)...`);

        let configured = 0;
        let skipped = 0;

        for (const tool of toConfigure) {
          try {
            const existing = tool.readConfig();

            if (tool.name === "OpenCode") {
              const mcpSection = (existing as any).mcp || {};
              mcpSection.astrivya = buildOpenCodeEntry(apiUrl, provider, apiKey);
              (existing as any).mcp = mcpSection;
            } else {
              const servers = (existing as any).mcpServers || {};
              servers.astrivya = buildMcpServiceEntry(apiUrl, provider, apiKey);
              (existing as any).mcpServers = servers;
            }

            tool.writeConfig(existing);
            configured++;
          } catch (err: unknown) {
            skipped++;
            spinner.stop();
            console.log(`  ${color.red("\u2717")} ${tool.name} \u2014 ${getErrorMessage(err)}`);
            spinner.start();
          }
        }

        spinner.stop();
        console.log();
        success(`${configured} configured, ${skipped} skipped.`);

        if (configured > 0) {
          console.log(`\n  Set ${color.cyan("ASTRIVYA_TOKEN")} in your shell:\n`);
          console.log(`    export ASTRIVYA_TOKEN="${token}"`);
          console.log();
          console.log(`  Next: ${color.cyan("astrivya doctor")} to verify your setup.`);
          console.log(`  Then install the VS Code extension: ${dim("https://astrivya.ai/extension")}\n`);
        }
      } catch (err: unknown) {
        error(`Setup failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

export type { ToolDetector };
export { ALL_TOOLS, buildMcpServiceEntry, buildOpenCodeEntry };
