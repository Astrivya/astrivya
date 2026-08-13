import type { Command } from "commander";
import { runInstall } from "../lib/auto-update";
import { color, info, success, warn } from "../lib/output";
import {
  buildInstallCommand,
  detectInstallManager,
  fetchLatestVersion,
  semverCompare,
  setDisabled,
} from "../lib/update-notifier";
import { CURRENT_VERSION } from "../lib/version";

export function registerUpdate(program: Command): void {
  const update = program.command("update").description("Check for and install the latest version of astrivya");

  update.action(async () => {
    const latest = await fetchLatestVersion();
    if (!latest) {
      warn("Could not check for updates. Check your internet connection.");
      return;
    }
    if (semverCompare(latest, CURRENT_VERSION) <= 0) {
      success(`You're on the latest version (${CURRENT_VERSION}).`);
      return;
    }
    const manager = detectInstallManager();
    info(`Update available: ${CURRENT_VERSION} ${color.dim("\u2192")} ${color.bold(latest)} (via ${manager}).`);
    if (!runInstall(buildInstallCommand(manager))) process.exit(1);
  });

  update
    .command("check")
    .description("Check if a new version is available")
    .action(async () => {
      info(`Current version: ${color.bold(CURRENT_VERSION)}`);
      const latest = await fetchLatestVersion();
      if (!latest) {
        warn("Could not check for updates. Check your internet connection.");
        return;
      }
      info(`Latest version:  ${color.bold(latest)}`);
      const cmp = semverCompare(latest, CURRENT_VERSION);
      if (cmp > 0) {
        console.log(
          `\n  ${color.green("\u2B06")} Update available: ${color.dim(`${CURRENT_VERSION} \u2192 `)}${color.bold(latest)}`,
        );
        console.log(`  Run ${color.cyan("`astrivya update`")} to install.\n`);
      } else if (cmp === 0) {
        success(`You're on the latest version (${CURRENT_VERSION}).`);
      } else {
        console.log(`\n  ${color.dim("You're ahead of the published version (dev build).")}\n`);
      }
    });

  update
    .command("install")
    .description("Download and install the latest version")
    .option("-f, --force", "Force install even if already up to date")
    .action(async (options: { force?: boolean }) => {
      if (!options.force) {
        const latest = await fetchLatestVersion();
        if (latest && semverCompare(latest, CURRENT_VERSION) <= 0) {
          success(`Already up to date (${CURRENT_VERSION}). Use --force to reinstall.`);
          return;
        }
      }
      if (!runInstall(buildInstallCommand(detectInstallManager()))) process.exit(1);
    });

  update
    .command("disable")
    .description("Stop showing update notifications")
    .action(() => {
      setDisabled(true);
      info("Update notifications disabled. You can still run `astrivya update` any time.");
    });

  update
    .command("enable")
    .description("Re-enable update notifications")
    .action(() => {
      setDisabled(false);
      info("Update notifications enabled.");
    });
}
