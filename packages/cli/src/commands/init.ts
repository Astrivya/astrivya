import type { Command } from "commander";
import { getErrorMessage } from "../lib/output";
import { prompt } from "../lib/prompt";

async function runCli(args: string): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`node ${process.argv[1]} ${args}`, { stdio: "inherit", cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Guided first-run setup wizard (use --yes for a non-interactive default run)")
    .option("-y, --yes", "Run with default choices, no prompts (non-TTY safe)")
    .option("--skip-index", "Skip indexing during --yes")
    .option("--skip-doctor", "Skip the health check during --yes")
    .action(async (options) => {
      try {
        const nonInteractive = !!(options.yes || !process.stdin.isTTY);

        if (nonInteractive) {
          console.log("\n  Non-interactive mode: indexing + health check will run; Atlas launch skipped.\n");
        }

        console.log(`
+----------------------------------------------------+
|       Welcome to Astrivya Knowledge Graph          |
+----------------------------------------------------+

This wizard will help you get started in 3 quick steps.
Press Ctrl+C at any time to skip a step.
`);

        // Step 1: Index workspace
        console.log("Step 1/3: Index your workspace");
        const skipIndex = !!(options.yes && options.skipIndex);
        const wantIndex = skipIndex
          ? false
          : nonInteractive
            ? true
            : (await prompt("Index the current directory into the knowledge graph? (Y/n): ")).toLowerCase() !== "n";
        if (wantIndex) {
          console.log("  Running: astrivya akg init --index\n");
          if (await runCli("akg init --index")) {
            console.log("  + Workspace indexed");
          } else {
            console.log("  o Indexing skipped or failed -- run `astrivya akg init` later");
          }
        } else {
          console.log("  o Indexing skipped");
        }

        // Step 2: Verify
        console.log("\nStep 2/3: Verify your setup");
        const skipDoctor = !!(options.yes && options.skipDoctor);
        const wantDoctor =
          skipDoctor
            ? false
            : nonInteractive
              ? true
              : (await prompt("Run a health check? (Y/n): ")).toLowerCase() !== "n";
        if (wantDoctor) {
          if (await runCli("doctor")) {
            console.log("  + Health check complete");
          } else {
            console.log("  o Health check failed -- run `astrivya doctor` for details");
          }
        } else {
          console.log("  o Health check skipped");
        }

        // Step 3: Atlas dashboard (interactive only — never block on automation)
        console.log("\nStep 3/3: Launch the visual dashboard");
        if (nonInteractive) {
          console.log("  o Skipped (non-interactive mode) -- run `astrivya atlas` anytime");
        } else {
          const wantAtlas = (await prompt("Start the Atlas knowledge graph explorer? (Y/n): ")).toLowerCase() !== "n";
          if (wantAtlas && !(await runCli("atlas"))) {
            console.log("  o Atlas not started -- run `astrivya atlas` later");
          }
        }

        // Done
        console.log(`
+------------------------------------------------+
|         Setup complete! Next steps:             |
+------------------------------------------------+

  1. astrivya akg status       - View knowledge graph stats
  2. astrivya doctor           - Verify everything works
  3. astrivya mcp-server       - Start MCP for AI agent integration
  4. astrivya mcp              - Inspect MCP session activity
  5. astrivya atlas            - Launch the visual graph explorer

  Docs: https://github.com/astrivya/astrivya/tree/main/oss/docs
`);
      } catch (err: unknown) {
        console.error("Setup wizard failed:", getErrorMessage(err));
        process.exit(1);
      }
    });
}