import { PluginManager } from "@astrivya/plugin-runtime";
import type { Command } from "commander";
import { getBaseUrl, getPremiumAuth } from "../lib/compat";
import { json as printJson } from "../lib/output";

export function registerPlugins(program: Command): void {
  const plugins = program.command("plugins").description("Manage Astrivya Cloud plugins");

  plugins
    .command("list")
    .description("List installed plugins")
    .option("--json", "Output raw JSON")
    .action(async (options) => {
      try {
        const pm = new PluginManager(undefined, getBaseUrl());
        const entries = await pm.list();
        if (options.json) {
          printJson(entries);
          return;
        }
        if (entries.length === 0) {
          console.log("\n  No plugins installed.\n");
          return;
        }
        console.log(`\n  Installed plugins (${entries.length}):`);
        for (const e of entries) {
          const stateIcon =
            e.state === "verified"
              ? "\u2713"
              : e.state === "corrupted"
                ? "\u2717"
                : e.state === "disabled"
                  ? "\u25CB"
                  : "?";
          const caps = (e.capabilities || []).join(", ");
          console.log(`  ${stateIcon} ${e.id} v${e.version} [${caps}] \u2014 ${e.state}`);
        }
        console.log();
      } catch (err) {
        console.error(`Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  plugins
    .command("sync")
    .description("Synchronize plugins from Astrivya Cloud")
    .action(async () => {
      try {
        const token = getPremiumAuth();
        if (!token) {
          console.log("\n  Not authenticated. Run: astrivya auth login\n");
          process.exitCode = 1;
          return;
        }
        const pm = new PluginManager(undefined, getBaseUrl());
        console.log("  Synchronizing plugins...");
        const result = await pm.sync(token);
        if (result.synced.length > 0) {
          const joined = result.synced.join(", ");
          console.log(`  \u2713 Installed: ${joined}`);
        }
        if (result.updated.length > 0) {
          console.log(`  \u2191 Updated: ${result.updated.join(", ")}`);
        }
        if (result.failed.length > 0) {
          console.log(`  \u2717 Failed: ${result.failed.map((f) => `${f.id} (${f.error})`).join(", ")}`);
        }
        if (result.removed.length > 0) {
          console.log(`  \u25CB Removed: ${result.removed.join(", ")}`);
        }
        if (result.synced.length === 0 && result.updated.length === 0 && result.failed.length === 0) {
          console.log("  All plugins are up to date.");
        }
        console.log();
      } catch (err) {
        console.error(`Plugin sync failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  plugins
    .command("doctor")
    .description("Verify installed plugin integrity")
    .option("--json", "Output raw JSON")
    .action(async (options) => {
      try {
        const pm = new PluginManager(undefined, getBaseUrl());
        const result = await pm.verify();
        if (options.json) {
          printJson(result);
          return;
        }
        console.log("\n  Plugin integrity check:");
        for (const entry of result.entries) {
          const icon = entry.state === "verified" ? "\u2713" : "\u2717";
          const detail = entry.error ? ` \u2014 ${entry.error}` : "";
          console.log(`  ${icon} ${entry.id}: ${entry.state}${detail}`);
        }
        console.log(
          result.ok ? "  All plugins verified.\n" : "  Some plugins are corrupted. Run: astrivya plugins sync\n",
        );
      } catch (err) {
        console.error(`Plugin verification failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  plugins
    .command("update [plugin-id]")
    .description("Update a specific plugin or all plugins")
    .action(async (pluginId) => {
      try {
        const token = getPremiumAuth();
        if (!token) {
          console.log("\n  Not authenticated. Run: astrivya auth login\n");
          process.exitCode = 1;
          return;
        }
        const pm = new PluginManager(undefined, getBaseUrl());
        if (pluginId) {
          console.log(`  Updating ${pluginId}...`);
          await pm.update(pluginId, token);
          console.log(`  \u2713 ${pluginId} updated.\n`);
        } else {
          console.log("  Updating all plugins...");
          const result = await pm.sync(token);
          if (result.updated.length > 0) {
            console.log(`  \u2191 Updated: ${result.updated.join(", ")}`);
          } else {
            console.log("  All plugins are up to date.");
          }
          console.log();
        }
      } catch (err) {
        console.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  plugins
    .command("clear")
    .description("Remove all installed plugins")
    .action(async () => {
      try {
        const pm = new PluginManager(undefined, getBaseUrl());
        await pm.clear();
        console.log("  \u2713 All plugins removed.\n");
      } catch (err) {
        console.error(`Failed to clear plugins: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    });
}
