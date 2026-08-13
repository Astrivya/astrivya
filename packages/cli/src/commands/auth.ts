import { hostname } from "node:os";
import { PluginManager } from "@astrivya/plugin-runtime";
import type { Command } from "commander";
import { openBrowser } from "../lib/browser";
import {
  apiCall,
  clearConfig,
  clearLicenseKey,
  findFreePort,
  getBaseUrl,
  getLicenseKey,
  getPremiumAuth,
  getToken,
  loadConfig,
  saveConfig,
  saveLicenseKey,
  startOAuthServer,
} from "../lib/compat";
import { getErrorMessage, json as printJson } from "../lib/output";

export async function runLoginFlow(): Promise<{ profile?: { email?: string } }> {
  const existing = getToken();
  if (existing) {
    clearConfig();
  }

  const port = await findFreePort(18080);
  if (!port) {
    throw new Error("Could not find a free port for the auth callback server.");
  }

  const baseUrl = getBaseUrl();
  const authUrl = `${baseUrl}/auth/cli?cli_port=${port}`;

  console.log("Opening browser for authentication...");
  await openBrowser(authUrl);

  console.log("Waiting for authentication callback...");
  const result = await startOAuthServer(port);

  saveConfig({ token: result.token, baseUrl });

  // Exchange short-lived token for a long-lived personal access token (PAT) for the device
  try {
    const hn = hostname();
    const deviceName = `${hn} - CLI`;
    const tokenResult = await apiCall("/api/ide/token", "POST", { device_name: deviceName });
    if (tokenResult?.token) {
      saveConfig({ token: tokenResult.token });
    }
  } catch {
    // Fallback to using the session token if the exchange endpoint fails
  }

  // Sync plugins after successful login
  try {
    const token = getPremiumAuth();
    if (token) {
      const pm = new PluginManager(undefined, getBaseUrl());
      const syncResult = await pm.sync(token);
      if (syncResult.synced.length > 0) {
        console.error(`[Astrivya] Installed ${syncResult.synced.length} plugin(s)`);
      }
      if (syncResult.updated.length > 0) {
        console.error(`[Astrivya] Updated ${syncResult.updated.length} plugin(s)`);
      }
      if (syncResult.failed.length > 0) {
        console.error(`[Astrivya] ${syncResult.failed.length} plugin(s) failed to install`);
      }
    }
  } catch {
    // Plugin sync failed — user can run `astrivya plugins sync` later
  }

  return result;
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Authentication commands");

  auth
    .command("login")
    .description("Authenticate with Astrivya (opens browser)")
    .action(async () => {
      try {
        const result = await runLoginFlow();

        const email = result.profile?.email || "";
        console.log(`\n✓ Authenticated${email ? ` as ${email}` : ""}.`);
        console.log(`
  Next steps:
  1. astrivya setup           → Configuration wizard
  2. astrivya sync github     → Import your repos
  3. astrivya decision log    → Log your first decision
  4. astrivya who <topic>     → Discover team expertise
  5. astrivya context <topic> → Get context on any topic
  6. Install the VS Code extension → https://astrivya.ai/extension

  Tip: use \`astrivya s "query"\` as a shortcut for search
`);
      } catch (err: unknown) {
        console.error("Authentication failed:", getErrorMessage(err));
        process.exitCode = 1;
      }
    });

  auth
    .command("logout")
    .description("Clear stored authentication")
    .action(() => {
      clearConfig();
      console.log("✓ Logged out. Stored credentials cleared.");
    });

  auth
    .command("whoami")
    .description("Show current user info")
    .action(async () => {
      try {
        const token = getToken();
        if (!token) {
          console.log("Not authenticated. Run `astrivya auth login` first.");
          return;
        }

        const profile = await apiCall("/api/ide/me", "GET");
        const email = profile.email || "unknown";
        const name = profile.full_name || profile.name || "";
        console.log(`\n  Authenticated as: ${name ? `${name} (` : ""}${email}${name ? ")" : ""}`);
        if (profile.id) console.log(`  User ID: ${profile.id}`);
        const config = loadConfig();
        if (config.teamId) console.log(`  Default team: ${config.teamId}`);
      } catch (err: unknown) {
        console.error("Failed to fetch profile:", getErrorMessage(err));
        process.exitCode = 1;
        return;
      }
    });

  auth
    .command("token")
    .description("Get, set, or refresh your personal access token")
    .option("-s, --show", "Show the full token")
    .option("-r, --refresh", "Generate a new token")
    .option("--set <token>", "Set a token directly (for headless/CI environments)")
    .option("--json", "Output raw JSON")
    .option("--ndjson", "Output newline-delimited JSON")
    .action(async (options) => {
      try {
        if (options.set) {
          try {
            const baseUrl = getBaseUrl();
            const res = await fetch(`${baseUrl}/api/ide/me`, {
              headers: { Authorization: `Bearer ${options.set}` },
              signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) {
              throw new Error(`Token rejected by server (HTTP ${res.status})`);
            }
          } catch (err: unknown) {
            console.error(`Invalid token: ${getErrorMessage(err)}`);
            process.exitCode = 1;
            return;
          }
          saveConfig({ token: options.set });
          console.log("✓ Token validated and saved.");
          return;
        }
        if (options.refresh) {
          const sessionToken = getToken();
          if (!sessionToken) {
            console.error("Not authenticated. Run `astrivya auth login` first.");
            process.exitCode = 1;
            return;
          }
          const hn = hostname();
          const deviceName = `${hn} - CLI`;
          const result = await apiCall("/api/ide/token", "POST", { device_name: deviceName });
          saveConfig({ token: result.token });
          console.log("✓ New token generated and saved.");
        }

        const token = getToken();
        if (!token) {
          console.error("No token found. Run `astrivya auth login` first.");
          process.exitCode = 1;
          return;
        }

        if (options.ndjson) {
          console.log(JSON.stringify({ token }));
          return;
        }

        if (options.json) {
          printJson({ token });
          return;
        }

        if (options.show) {
          console.log(`\n  ${token}\n`);
        } else {
          const masked = `${token.slice(0, 6)}…${token.slice(-4)}`;
          console.log(`\n  Token: ${masked}`);
          console.log("  Use --show to display the full token or --refresh to generate a new one.\n");
        }
      } catch (err: unknown) {
        console.error("Token command failed:", getErrorMessage(err));
        process.exitCode = 1;
        return;
      }
    });

  auth
    .command("license")
    .description("Activate, check, or clear your Astrivya license key")
    .argument("[key]", "License key to activate (astlk_...)")
    .option("--status", "Show current license status and expiry")
    .option("--void", "Clear the stored license key")
    .action(async (key: string | undefined, options: { status?: boolean; void?: boolean }) => {
      try {
        if (options.void) {
          clearLicenseKey();
          console.log("cleared stored license key.");
          return;
        }

        if (!key && options.status) {
          const token = getToken();
          if (!token) {
            console.log("Not authenticated. Run `astrivya auth login` first.");
            return;
          }
          const status = await apiCall("/api/tier", "GET");
          const tier = status?.tier;
          if (!tier || tier === "starter") {
            console.log("No active plan. Visit the billing page to upgrade.");
            return;
          }
          console.log(`  Tier: ${tier}`);
          if (status?.tierExpiresAt) {
            const d = new Date(status.tierExpiresAt);
            console.log(`  Expires: ${d.toLocaleDateString()}`);
          }
          console.log("  Status: active");
          return;
        }

        if (!key) {
          console.log("Usage: astrivya auth license <key> | auth license --status | auth license --void");
          return;
        }

        const baseUrl = getBaseUrl();
        const res = await fetch(`${baseUrl}/api/ide/me`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          if (res.status === 401) {
            console.error("License key rejected by server (invalid, revoked, or expired).");
          } else {
            console.error(`License key rejected by server (HTTP ${res.status})`);
          }
          process.exitCode = 1;
          return;
        }

        saveLicenseKey(key);
        console.log("License key activated and saved.");
      } catch (err: unknown) {
        console.error("License command failed:", getErrorMessage(err));
        process.exitCode = 1;
        return;
      }
    });
}
