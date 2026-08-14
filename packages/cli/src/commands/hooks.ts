import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { color, error as printError, success } from "../lib/output";

/**
 * Locate install-git-hooks.js by filesystem existence, never by `require()`.
 * The script runs install/uninstall from its top-level code based on argv, so
 * requiring it here would silently install hooks as a side effect of merely
 * resolving the path (e.g. `astrivya hooks status` would install hooks).
 */
function getHookScriptPath(): string {
  const candidates = [
    resolve(__dirname, "../../scripts/install-git-hooks.js"), // src layout
    resolve(__dirname, "../scripts/install-git-hooks.js"), // dist layout
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("install-git-hooks.js not found — is the CLI installed correctly?");
}

export function registerHooks(program: Command): void {
  const hooks = program.command("hooks").description("Manage AKG git hooks for auto-indexing on commit/merge");

  hooks
    .command("install")
    .description("Install post-commit and post-merge hooks to auto-index AKG")
    .action(() => {
      try {
        const script = getHookScriptPath();
        execSync(`node "${script}" install`, { cwd: process.cwd(), stdio: "inherit" });
        success("AKG hooks installed. The knowledge graph will re-index on every commit and merge.");
      } catch (err: unknown) {
        printError(`Failed to install hooks: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  hooks
    .command("uninstall")
    .description("Remove Astrivya git hooks and restore previous hooks")
    .action(() => {
      try {
        const script = getHookScriptPath();
        execSync(`node "${script}" uninstall`, { cwd: process.cwd(), stdio: "inherit" });
        success("AKG hooks removed.");
      } catch (err: unknown) {
        printError(`Failed to uninstall hooks: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  hooks
    .command("status")
    .description("Check if AKG hooks are installed")
    .action(() => {
      const fs = require("node:fs");
      const path = require("node:path");

      let dir = process.cwd();
      const root = path.parse(dir).root;
      let gitRoot = null;
      while (dir !== root) {
        if (fs.existsSync(path.join(dir, ".git"))) {
          gitRoot = dir;
          break;
        }
        dir = path.dirname(dir);
      }

      if (!gitRoot) {
        console.log(color.dim("No .git directory found in this or parent directories."));
        process.exit(0);
      }

      const hooksDir = path.join(gitRoot, ".git", "hooks");
      const hooks = ["post-commit", "post-merge"];
      let installed = 0;

      for (const hook of hooks) {
        const hookPath = path.join(hooksDir, hook);
        if (fs.existsSync(hookPath)) {
          const content = fs.readFileSync(hookPath, "utf-8");
          if (content.includes("Astrivya AKG auto-index hook")) {
            installed++;
            console.log(`  ${color.green("\u2713")} ${hook}`);
          } else {
            console.log(`  ${color.yellow("!")} ${hook} (exists, not managed by Astrivya)`);
          }
        } else {
          console.log(`  ${color.dim("\u2013")} ${hook} (not installed)`);
        }
      }

      console.log();
      if (installed === hooks.length) {
        success("All AKG hooks installed.");
      } else if (installed > 0) {
        console.log(color.yellow("Some hooks are missing. Run `astrivya hooks install` to fix."));
      } else {
        console.log(color.dim("No AKG hooks installed. Run `astrivya hooks install` to enable auto-indexing."));
      }
    });
}
