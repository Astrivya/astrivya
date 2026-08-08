import type { Command } from "commander";
import { loadConfig, saveConfig } from "../lib/compat";
import { color, json as printJson, table } from "../lib/output";

function printConfigGuide(path: string, config: string) {
  console.error(color.dim(`\u203A Add this to ${path}:`));
  console.log(config);
}

export function registerConfig(program: Command): void {
  const cfg = program.command("config").description("Manage CLI settings and print integration configs");

  cfg
    .command("list")
    .description("Show all configuration values")
    .option("--json", "Output raw JSON")
    .action(async (options) => {
      const config = loadConfig();
      if (options.json) {
        printJson(config);
        return;
      }
      const entries = Object.entries(config).filter(([_, v]) => v !== undefined);
      if (entries.length === 0) {
        console.log(`${color.dim("No configuration set.")}`);
        return;
      }
      console.log(`\n${color.bold("Configuration:")}\n`);
      table(
        ["Key", "Value"],
        entries.map(([k, v]) => [k, String(v)]),
      );
      console.log();
    });

  cfg
    .command("get <key>")
    .description("Get a configuration value")
    .action((key) => {
      const config = loadConfig();
      const val = (config as any)[key];
      if (val === undefined) {
        console.log(`${color.dim(`"${key}" is not set.`)}`);
        return;
      }
      console.log(String(val));
    });

  cfg
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key, value) => {
      const parsed: Record<string, string> = {};
      parsed[key] = value;
      saveConfig(parsed);
      console.log(`${color.green("\u2713")} ${key} = ${value}`);
    });

  cfg
    .command("unset <key>")
    .description("Remove a configuration value")
    .action((key) => {
      saveConfig({ [key]: undefined } as any);
      console.log(`${color.green("\u2713")} ${key} removed.`);
    });

  cfg
    .command("mcp")
    .description("Print Claude Desktop MCP config")
    .action(() => {
      printConfigGuide(
        "~/Library/Application Support/Claude/claude_desktop_config.json",
        JSON.stringify(
          {
            mcpServers: {
              astrivya: {
                command: "npx",
                args: ["-y", "@astrivya/mcp-server"],
              },
            },
          },
          null,
          2,
        ),
      );
    });

  cfg
    .command("cursor")
    .description("Print Cursor MCP config (for .cursor/mcp.json)")
    .action(() => {
      printConfigGuide(
        ".cursor/mcp.json (project root)",
        JSON.stringify(
          {
            mcpServers: {
              astrivya: {
                command: "npx",
                args: ["-y", "@astrivya/mcp-server"],
              },
            },
          },
          null,
          2,
        ),
      );
    });

  cfg
    .command("vscode")
    .description("Print VS Code MCP config (for settings.json)")
    .action(() => {
      printConfigGuide(
        "~/.vscode/settings.json or .vscode/settings.json",
        JSON.stringify(
          {
            "mcp.servers": {
              astrivya: {
                command: "npx",
                args: ["-y", "@astrivya/mcp-server"],
              },
            },
          },
          null,
          2,
        ),
      );
    });

  cfg
    .command("opencode")
    .description("Print opencode MCP config (for opencode.json)")
    .action(() => {
      printConfigGuide(
        "opencode.json (project root)",
        JSON.stringify(
          {
            mcp: {
              astrivya: {
                type: "local",
                command: ["npx", "-y", "@astrivya/mcp-server"],
                enabled: true,
              },
            },
          },
          null,
          2,
        ),
      );
    });

  cfg
    .command("antigravity")
    .description("Print Antigravity IDE MCP config (for settings.json)")
    .action(() => {
      printConfigGuide(
        "~/.antigravity-ide/user/settings.json",
        JSON.stringify(
          {
            "mcp.servers": {
              astrivya: {
                command: "npx",
                args: ["-y", "@astrivya/mcp-server"],
              },
            },
          },
          null,
          2,
        ),
      );
    });

  cfg
    .command("kiro")
    .description("Print Kiro MCP config (for kiro-power.yaml)")
    .action(() => {
      const yaml = [
        "# kiro-power.yaml",
        "name: astrivya-context",
        "description: Team memory and knowledge for your codebase",
        "mcp_servers:",
        "  - name: astrivya",
        "    command: npx",
        '    args: ["-y", "@astrivya/mcp-server"]',
        "steering:",
        "  - path: .kiro/steering/astrivya.md",
        "    content: |",
        "      When answering questions about this codebase, always check",
        "      Astrivya team knowledge first using the search_memories tool.",
      ].join("\n");
      console.error(
        color.dim("\u203A Save as kiro-power.yaml in project root, then run: kiro power enable astrivya-context"),
      );
      console.log(yaml);
    });

  cfg
    .command("windsurf")
    .description("Print Windsurf MCP config")
    .action(() => {
      printConfigGuide(
        "~/.codeium/windsurf/mcp_config.json",
        JSON.stringify(
          {
            mcpServers: {
              astrivya: {
                command: "npx",
                args: ["-y", "@astrivya/mcp-server"],
              },
            },
          },
          null,
          2,
        ),
      );
    });

  cfg
    .command("jetbrains")
    .description("Print JetBrains MCP config (for .mcp/config.json)")
    .action(() => {
      printConfigGuide(
        ".mcp/config.json (project root)",
        JSON.stringify(
          {
            servers: {
              astrivya: {
                command: ["npx", "-y", "@astrivya/mcp-server"],
              },
            },
          },
          null,
          2,
        ),
      );
    });
}
