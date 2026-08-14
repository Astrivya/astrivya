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
      process.exitCode = 1;
      try {
        process.stdin.destroy();
      } catch {}
      // If a stray listener keeps the event loop alive (e.g. the TUI failed
      // mid-start in a non-TTY session), force-exit shortly after — by then
      // any network handles from the update check have long been closed.
      setTimeout(() => process.exit(1), 2000).unref();
    });
    return;
  }
  console.error(color.red(`Unknown command: ${program.args.join(" ")}`));
  program.outputHelp({ error: true });
  process.exit(1);
}
