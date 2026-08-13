import type { Command } from "commander";
import { color, getErrorMessage } from "./output";

/**
 * Root-command handler for the CLI entry point.
 *
 * `astrivya` with no arguments starts the interactive TUI. Commander also
 * routes *unknown* commands here (e.g. `astrivya frobnicate`); those are
 * user errors — print them and exit non-zero instead of launching the TUI,
 * which would hang any non-TTY session (CI, pipes, scripts).
 */
export function runRootAction(program: Command, startTui: () => Promise<void>): void {
  if (program.args.length === 0) {
    startTui().catch((err: unknown) => {
      console.error("TUI error:", getErrorMessage(err));
      process.exit(1);
    });
    return;
  }
  console.error(color.red(`Unknown command: ${program.args.join(" ")}`));
  program.outputHelp({ error: true });
  process.exit(1);
}
