import { runLoginFlow } from "../commands/auth";
import { askYesNo } from "./auto-update";
import { getToken } from "./compat";
import { color } from "./output";

export interface AuthGuardOptions {
  /** Override the TTY check (used by tests) */
  interactive?: boolean;
  /** Override the yes/no prompt (used by tests) */
  ask?: () => Promise<boolean>;
  /** Override the login flow (used by tests) */
  login?: () => Promise<unknown>;
}

/**
 * Gate for cloud commands: returns true when the user is authenticated.
 * When not authenticated, explains the situation and — on an interactive
 * terminal — offers to run the browser login flow right away.
 */
export async function ensureAuth(opts: AuthGuardOptions = {}): Promise<boolean> {
  if (getToken()) return true;

  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
  const hint = () => console.log(`  Run ${color.cyan("astrivya auth login")} to authenticate, then retry.`);

  console.log(color.yellow("You're not logged in. Cloud commands require an Astrivya account."));
  if (!interactive) {
    hint();
    return false;
  }

  const ask = opts.ask ?? (() => askYesNo("  Log in now? [y/N] "));
  const yes = await ask();
  if (!yes) {
    hint();
    return false;
  }

  console.log();
  try {
    const login = opts.login ?? runLoginFlow;
    await login();
  } catch (err: unknown) {
    console.error(`  Login failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  if (!getToken()) {
    console.log("  Login did not complete. Try `astrivya auth login` again.");
    return false;
  }
  return true;
}
