import { spawn } from "node:child_process";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { AkgEmbedder, AkgIndexer } from "@astrivya/akg-indexer";
import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import envPaths from "env-paths";
import { createIndexRenderer } from "../lib/index-progress";
import { color, getErrorMessage } from "../lib/output";

const WELCOME = `
  ┌────────────────────────────────────────────────┐
  │   Welcome to Astrivya Knowledge Graph (AKG)    │
  └────────────────────────────────────────────────┘

  Astrivya builds a local, private knowledge graph of your
  workspace — code, docs, ADRs and agent logs — so AI agents
  can answer questions with real context.

  This wizard will set you up in 3 quick steps.
`;

/**
 * Run the AKG indexer in-process with live terminal progress.
 * Never spawns a child CLI process — fast, and works no matter
 * how the CLI itself was installed.
 */
async function runIndex(workspacePath: string, withEmbed: boolean): Promise<boolean> {
  const renderer = createIndexRenderer();
  try {
    const storage = new AkgStorage();
    await storage.init(workspacePath);

    const indexer = new AkgIndexer(storage, workspacePath);
    const result = await indexer.indexWorkspaceDetailed((ev) => renderer.update(ev), {
      parallel: true,
    });

    let embResult: { embedded: number; total: number } | null = null;
    if (withEmbed) {
      try {
        const embedder = new AkgEmbedder();
        const modelsDir = path.join(envPaths("astrivya", { suffix: "" }).config, "models");
        embResult = await embedder.embedAllChunks(storage, modelsDir, (done, total) => renderer.embed(done, total));
      } catch {
        embResult = null;
      }
    }

    renderer.done(
      result,
      embResult
        ? { embedded: embResult.embedded, embeddedTotal: embResult.total }
        : withEmbed
          ? { embedSkipped: "local ONNX model unavailable (keyword search still works)" }
          : {},
    );
    return true;
  } catch (err: unknown) {
    renderer.fail(getErrorMessage(err));
    return false;
  }
}

/** Run the doctor health check in-process and stream its output. */
async function runDoctor(): Promise<boolean> {
  const { executeCommandSafely } = await import("../lib/command-registry");
  const result = await executeCommandSafely("doctor");
  const out = result.output.trim();
  if (out) console.log(`\n${out}\n`);
  if (result.error) {
    console.log(`  ${color.red("✗")} Health check failed: ${result.error}`);
    return false;
  }
  return true;
}

/** Spawn Atlas detached so the wizard can finish. Returns the target URL. */
function launchAtlas(workspacePath: string): string {
  const port = 4200;
  const url = `http://localhost:${port}`;
  const cliEntry = process.argv[1] || "astrivya";
  const child = spawn(process.execPath, [cliEntry, "serve", "-w", workspacePath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  child.unref();
  return url;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Guided first-run setup wizard (use --yes for a non-interactive default run)")
    .option("-y, --yes", "Run with default choices, no prompts (non-TTY safe)")
    .option("--skip-index", "Skip indexing during --yes")
    .option("--skip-doctor", "Skip the health check during --yes")
    .option("--no-embed", "Skip vector embeddings during indexing")
    .action(async (options) => {
      try {
        const nonInteractive = !!(options.yes || !process.stdin.isTTY);

        console.log(WELCOME);
        if (nonInteractive) {
          console.log("  Non-interactive mode: indexing + health check will run; Atlas launch skipped.\n");
        }

        // Step 1: Index workspace
        console.log(`  ${color.bold("Step 1/3")} — Index your workspace`);
        const wantIndex =
          options.yes && options.skipIndex
            ? false
            : nonInteractive
              ? true
              : await confirm({ message: "Auto-index this workspace into the knowledge graph?", default: true });

        if (wantIndex) {
          console.log(`  ${color.dim("Indexing... (this may take a few seconds)")}\n`);
          const ok = await runIndex(process.cwd(), options.embed !== false);
          if (ok) {
            console.log(`  ${color.green("✓")} Workspace indexed`);
          } else {
            console.log(`  ${color.yellow("○")} Indexing failed — run \`astrivya akg init\` later`);
          }
        } else {
          console.log(`  ${color.dim("○")} Indexing skipped`);
        }

        // Step 2: Verify
        console.log(`\n  ${color.bold("Step 2/3")} — Verify your setup`);
        const wantDoctor =
          options.yes && options.skipDoctor
            ? false
            : nonInteractive
              ? true
              : await confirm({ message: "Run a health check?", default: true });

        if (wantDoctor) {
          const ok = await runDoctor();
          if (ok) {
            console.log(`  ${color.green("✓")} Health check complete`);
          } else {
            console.log(`  ${color.yellow("○")} Health check failed — run \`astrivya doctor\` for details`);
          }
        } else {
          console.log(`  ${color.dim("○")} Health check skipped`);
        }

        // Step 3: Atlas dashboard (interactive only — never block on automation)
        console.log(`\n  ${color.bold("Step 3/3")} — Launch the visual dashboard`);
        if (nonInteractive) {
          console.log(`  ${color.dim("○")} Skipped (non-interactive mode) — run \`astrivya atlas\` anytime`);
        } else {
          const wantAtlas = await confirm({ message: "Start the Atlas knowledge graph explorer?", default: true });
          if (wantAtlas) {
            const url = launchAtlas(process.cwd());
            console.log(`  ${color.green("✓")} Atlas launched at ${color.cyan(url)} (in the background)`);
          } else {
            console.log(`  ${color.dim("○")} Atlas not started — run \`astrivya atlas\` later`);
          }
        }

        // Done
        console.log(`
  ┌────────────────────────────────────────────┐
  │         Setup complete! Next steps         │
  └────────────────────────────────────────────┘

  1. ${color.cyan("astrivya akg status")}   — View knowledge graph stats
  2. ${color.cyan("astrivya doctor")}       — Verify everything works
  3. ${color.cyan("astrivya mcp-server")}   — Start MCP for AI agent integration
  4. ${color.cyan("astrivya mcp")}          — Inspect MCP session activity
  5. ${color.cyan("astrivya atlas")}        — Launch the visual graph explorer
  6. ${color.cyan("astrivya")}              — Open the interactive chat TUI

  Docs: https://github.com/astrivya/astrivya/tree/main/oss/docs
`);
      } catch (err: unknown) {
        console.error("Setup wizard failed:", getErrorMessage(err));
        process.exitCode = 1;
        return;
      }
    });
}
