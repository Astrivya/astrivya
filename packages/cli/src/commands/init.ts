import type { Command } from "commander";
import { getErrorMessage } from "../lib/output";
import { prompt } from "../lib/prompt";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Guided first-run setup wizard")
    .action(async () => {
      try {
        console.log(`
+----------------------------------------------------+
|       Welcome to Astrivya Knowledge Graph          |
+----------------------------------------------------+

This wizard will help you get started in 3 quick steps.
Press Ctrl+C at any time to skip a step.
`);

        // Step 1: Index workspace
        console.log("Step 1/3: Index your workspace");
        const wantIndex = await prompt("Index the current directory into the knowledge graph? (Y/n): ");
        if (wantIndex.toLowerCase() !== "n") {
          console.log("  Running: astrivya akg init --index\n");
          const { execSync } = await import("node:child_process");
          try {
            execSync(`node ${process.argv[1]} akg init --index`, {
              stdio: "inherit",
              cwd: process.cwd(),
            });
            console.log("  + Workspace indexed");
          } catch {
            console.log("  o Indexing skipped or failed -- run `astrivya akg init` later");
          }
        }

        // Step 2: Verify
        console.log("\nStep 2/3: Verify your setup");
        const wantDoctor = await prompt("Run a health check? (Y/n): ");
        if (wantDoctor.toLowerCase() !== "n") {
          const { execSync } = await import("node:child_process");
          try {
            execSync(`node ${process.argv[1]} doctor`, {
              stdio: "inherit",
              cwd: process.cwd(),
            });
            console.log("  + Health check complete");
          } catch {
            console.log("  o Health check failed -- run `astrivya doctor` for details");
          }
        }

        // Step 3: Atlas dashboard
        console.log("\nStep 3/3: Launch the visual dashboard");
        const wantAtlas = await prompt("Start the Atlas knowledge graph explorer? (Y/n): ");
        if (wantAtlas.toLowerCase() !== "n") {
          const { execSync } = await import("node:child_process");
          try {
            execSync(`node ${process.argv[1]} atlas`, {
              stdio: "inherit",
              cwd: process.cwd(),
            });
          } catch {
            console.log("  o Atlas not started -- run `astrivya atlas` later");
          }
        }

        // Done
        console.log(`
+----------------------------------------------------+
|         Setup complete! Next steps:                |
+----------------------------------------------------+

  1. astrivya akg status       - View knowledge graph stats
  2. astrivya doctor           - Verify everything works
  3. astrivya mcp-server       - Start MCP for AI agent integration
  4. astrivya atlas            - Launch the visual graph explorer

  Docs: https://github.com/astrivya/astrivya/tree/main/oss/docs
`);
      } catch (err: unknown) {
        console.error("Setup wizard failed:", getErrorMessage(err));
        process.exit(1);
      }
    });
}
