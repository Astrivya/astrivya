#!/usr/bin/env node
import { PluginManager } from "@astrivya/plugin-runtime";
import { Command } from "commander";
import { registerAkg } from "./commands/akg";
import { registerAtlas } from "./commands/atlas";
import { registerAuth } from "./commands/auth";
import { registerConfig } from "./commands/config";
import { registerCredits } from "./commands/credits";
import { registerDoctor } from "./commands/doctor";
import { registerHooks } from "./commands/hooks";
import { registerInit } from "./commands/init";
import { registerLocal } from "./commands/local";
import { registerMcp } from "./commands/mcp";
import { registerMcpServer } from "./commands/mcp-server";
import { registerPlugins } from "./commands/plugins";
import { registerRuntime } from "./commands/runtime";
import { registerSetup } from "./commands/setup";
import { registerStatus } from "./commands/status";
import { registerSync } from "./commands/sync";
import { registerTeam } from "./commands/team";
import { startTui } from "./commands/tui";
import { registerUpdate } from "./commands/update";
import { maybeAutoUpdate, maybeSyncPlugins } from "./lib/auto-update";
import { setGlobalProgram } from "./lib/command-registry";
import { getToken, setVerbose } from "./lib/compat";
import { runRootAction } from "./lib/entry-guard";
import { color, getErrorMessage, setPrintMode } from "./lib/output";
import { loadCommandPlugins } from "./lib/plugin";
import { CURRENT_VERSION } from "./lib/version";

async function main() {
  const program = new Command()
    .name("astrivya")
    .description(
      "Astrivya — local knowledge graph engine for AI coding agents.\n\nRun without arguments to start the interactive TUI.",
    )
    .version(CURRENT_VERSION)
    .showHelpAfterError(true)
    .addHelpText(
      "after",
      `
Quick start:
  ${color.cyan("astrivya init")}          One-time wizard: index + health check
  ${color.cyan("astrivya akg query <q>")} Search your knowledge graph
  ${color.cyan("astrivya doctor")}        Verify your setup
  ${color.cyan("astrivya mcp-server")}    Serve MCP to AI agents (npx-free)

Tips:
  • Run ${color.cyan("astrivya")} with no args for the interactive chat TUI
  • ${color.cyan("--yes")} makes init non-interactive for CI/agents
  • ${color.cyan("--print")} strips colors for scripts and logs
  • ${color.cyan("--json")} on status/mcp/doctor emits machine-readable output
`,
    )
    .option("--verbose", "Enable verbose debug logging")
    .option("--print", "Print-friendly output (no colors, clean formatting)")
    .option("--local", "Local-only mode (skip cloud features)")
    .option("--no-update-check", "Skip checking for updates")
    .hook("preAction", (thisCommand: Command) => {
      const opts = thisCommand.optsWithGlobals();
      if (opts.verbose) setVerbose(true);
      if (opts.print) setPrintMode(true);
    })
    .hook("preAction", async (thisCommand: Command) => {
      const opts = thisCommand.optsWithGlobals();
      const name = thisCommand.name();
      if (opts.updateCheck === false) return;
      if (name === "update" || thisCommand.parent?.name() === "update") return;
      await maybeAutoUpdate({ skipInstall: name === "mcp-server" });
    })
    .hook("postAction", async (thisCommand: Command) => {
      const opts = thisCommand.optsWithGlobals();
      await maybeSyncPlugins({ local: opts.local === true });
    })
    .action(() => {
      runRootAction(program, startTui);
    });

  // Local knowledge graph commands (always available)
  registerInit(program);
  registerAkg(program);
  registerConfig(program);
  registerStatus(program);
  registerMcp(program);
  registerMcpServer(program);
  registerSetup(program);
  registerDoctor(program);
  registerUpdate(program);
  registerHooks(program);
  registerLocal(program);
  registerRuntime(program);
  registerAtlas(program);
  registerAuth(program);
  registerCredits(program);
  registerSync(program);
  registerTeam(program);
  registerPlugins(program);

  // Discover and register cloud command plugins. Built-in commands win:
  // a plugin command whose name collides with an existing command is
  // skipped instead of crashing commander with a duplicate-name error.
  const pluginCommands = await loadCommandPlugins();
  for (const cmd of pluginCommands) {
    const { name } = cmd;
    if (name && program.commands.some((c) => c.name() === name)) {
      console.error(`[Astrivya] Skipping plugin command "${name}" — built-in command takes precedence.`);
      continue;
    }
    cmd.register(program);
  }

  // Register fallback handlers for discoverable (not yet installed) premium commands
  try {
    const pm = new PluginManager();
    const discoverable = await pm.getDiscoverableCommands();
    for (const dc of discoverable) {
      const alreadyRegistered = program.commands.some((c) => c.name() === dc.name);
      if (!alreadyRegistered) {
        const cmd = program.command(dc.name).description(dc.description);
        if (dc.aliases) {
          for (const alias of dc.aliases) {
            cmd.alias(alias);
          }
        }
        cmd.action(() => {
          console.log(`\nThe "${dc.name}" feature requires Astrivya Cloud.\n`);
          console.log("Run: astrivya plugins sync\nto install the latest plugins.\n");
        });
      }
    }
  } catch {
    // No cached discoverable commands — user may not be logged in yet
  }

  setGlobalProgram(program);
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(`${color.red("Fatal error:")}`, getErrorMessage(err));
  process.exit(1);
});
