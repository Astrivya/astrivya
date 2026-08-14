import { AkgStorage, mergeGraphs } from "@astrivya/akg-core";
import type { Command } from "commander";
import { openBrowser } from "../lib/browser";
import { apiCall, findFreePort, getBaseUrl, loadConfig, saveConfig, startOAuthServer } from "../lib/compat";
import { color, error, getErrorMessage, info, success } from "../lib/output";
import { prompt } from "../lib/prompt";

const SUPPORTED_PROVIDERS = ["github", "notion", "linear"] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];

interface Resource {
  id: string;
  name?: string;
  title?: string;
  [key: string]: unknown;
}

/** Display name for a resource (Notion pages expose `title`, others `name`). */
function resourceName(r: Resource): string {
  return r.name || r.title || r.id;
}

async function ensureConnectorAuth(provider: Provider): Promise<void> {
  try {
    const status = await apiCall(`/api/connectors/${provider}/status`, "GET");
    if (status.connected || status.status === "connected") {
      return;
    }
  } catch {}

  const port = await findFreePort(18090);
  if (!port) {
    throw new Error("Could not find free port for auth callback");
  }

  const baseUrl = getBaseUrl();
  const redirectUri = `http://127.0.0.1:${port}?connected=true`;
  const authUrl = `${baseUrl}/api/connectors/${provider}/auth?redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log(`Authenticating with ${provider}...`);

  const serverPromise = startOAuthServer(port, 120_000);
  await openBrowser(authUrl);

  try {
    await serverPromise;
  } catch {
    console.log(`\nTimed out waiting for ${provider} authorization.`);
    console.log(`Make sure you're logged into Astrivya in your browser (${baseUrl}).`);
    throw new Error(`Timed out waiting for ${provider} authorization`);
  }

  const status = await apiCall(`/api/connectors/${provider}/status`, "GET");
  if (!status.connected) {
    throw new Error(`Failed to connect ${provider}.`);
  }
  console.log(`\u2713 ${provider} connected.`);
}

function getResourceEndpoint(provider: Provider): string {
  const endpoints: Record<Provider, string> = {
    github: "/api/connectors/github/repos",
    notion: "/api/connectors/notion/pages",
    linear: "/api/connectors/linear/teams",
  };
  return endpoints[provider];
}

function getImportEndpoint(provider: Provider): string {
  return `/api/connectors/${provider}/import`;
}

export function registerSync(program: Command): void {
  const sync = program.command("sync").description("Sync data from connected tools and team knowledge graphs");

  // Team sync commands
  sync
    .command("init")
    .description("Initialize team sync with an API key")
    .option("--key <key>", "API key (prompts if not provided)")
    .action(async (options) => {
      let apiKey = options.key;
      if (!apiKey) {
        apiKey = await prompt("Enter your team sync API key: ");
      }
      apiKey = apiKey.trim();
      if (!apiKey) {
        error("API key is required.");
        process.exitCode = 1;
        return;
      }
      saveConfig({ syncApiKey: apiKey });
      success("Team sync initialized.");
    });

  sync
    .command("push")
    .description("Push local AKG changes to team relay")
    .option("--since <timestamp>", "Only push changes after this timestamp")
    .action(async (options) => {
      const config = loadConfig();
      const apiKey = (config as any).syncApiKey;
      if (!apiKey) {
        error("No sync API key found. Run `astrivya sync init` first.");
        process.exitCode = 1;
        return;
      }

      const relayUrl = process.env.ASTRIVYA_SYNC_URL || getBaseUrl().replace(/\/+$/, "");
      const since = options.since ? Number.parseInt(options.since, 10) : 0;

      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const graph = storage.exportGraph();

        const res = await fetch(`${relayUrl}/api/sync/push`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            nodes: graph.nodes,
            edges: graph.edges,
            chunks: graph.chunks,
            since,
          }),
        });

        if (res.status === 402) {
          error("Sync requires an active subscription.");
          process.exitCode = 1;
          return;
        }

        if (!res.ok) {
          const err = await res.text();
          error(`Push failed: ${err}`);
          process.exitCode = 1;
          return;
        }

        const result: any = await res.json();
        success(`Pushed ${result.accepted} items to team relay.`);
      } catch (err: unknown) {
        error(`Push failed: ${getErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  sync
    .command("pull")
    .description("Pull team changes from relay into local AKG")
    .action(async () => {
      const config = loadConfig();
      const apiKey = (config as any).syncApiKey;
      if (!apiKey) {
        error("No sync API key found. Run `astrivya sync init` first.");
        process.exitCode = 1;
        return;
      }

      const relayUrl = process.env.ASTRIVYA_SYNC_URL || getBaseUrl().replace(/\/+$/, "");

      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const localGraph = storage.exportGraph();

        const since = localGraph.exportedAt;
        const res = await fetch(`${relayUrl}/api/sync/pull?since=${since}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (res.status === 402) {
          error("Sync requires an active subscription.");
          process.exitCode = 1;
          return;
        }

        if (!res.ok) {
          const err = await res.text();
          error(`Pull failed: ${err}`);
          process.exitCode = 1;
          return;
        }

        const remoteData: any = await res.json();
        if (remoteData.nodes.length === 0 && remoteData.edges.length === 0) {
          info("No new changes from team.");
          return;
        }

        const merged = mergeGraphs(localGraph, remoteData as any);
        const result = storage.importGraph(merged.merged);
        success(
          `Pulled and merged: ${result.merged} items (${merged.nodeConflicts} node conflicts, ${merged.edgeConflicts} edge conflicts)`,
        );
      } catch (err: unknown) {
        error(`Pull failed: ${getErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  sync
    .command("status")
    .description("Show team sync status")
    .action(async () => {
      const config = loadConfig();
      const apiKey = (config as any).syncApiKey;

      if (!apiKey) {
        info("Sync not configured. Run `astrivya sync init` with an API key.");
        return;
      }

      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const stats = storage.getStats();

        const relayUrl = process.env.ASTRIVYA_SYNC_URL || getBaseUrl().replace(/\/+$/, "");
        const res = await fetch(`${relayUrl}/api/sync/pull?since=0`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (res.ok) {
          const data: any = await res.json();
          console.log(`\n  Local:   ${stats.nodes} nodes, ${stats.edges} edges`);
          console.log(`  Remote:  ${data.nodes?.length || 0} nodes, ${data.edges?.length || 0} edges`);
          console.log(`  Status:  ${color.green("Connected")}`);
        } else if (res.status === 402) {
          console.log(`\n  Local:   ${stats.nodes} nodes, ${stats.edges} edges`);
          console.log(`  Status:  ${color.yellow("Sync unavailable")}`);
        } else {
          console.log(`\n  Local:   ${stats.nodes} nodes, ${stats.edges} edges`);
          console.log(`  Status:  ${color.red("Disconnected")}`);
        }
        console.log();
      } catch {
        console.log(`\n  Status:  ${color.red("Relay unreachable")}\n`);
      }
    });

  sync
    .command("key")
    .description("Generate a new sync API key (requires browser login)")
    .option("--team <teamId>", "Team ID to create key for")
    .action(async (options) => {
      const config = loadConfig();
      const authToken = (config as any).token || process.env.ASTRIVYA_TOKEN;
      if (!authToken) {
        error("Not authenticated. Run `astrivya auth login` first.");
        process.exitCode = 1;
        return;
      }

      // The config schema uses camelCase (teamId/orgId); the old snake_case
      // `team_id` is never written by any command. Fall back through the
      // fields team create/join actually persist.
      const teamId = options.team || config.teamId || config.orgId || (config as any).team_id;
      if (!teamId) {
        error("Team ID required. Provide --team or join/create a team first (`astrivya team create|join`).");
        process.exitCode = 1;
        return;
      }

      const baseUrl = getBaseUrl();
      try {
        const res = await fetch(`${baseUrl}/api/sync/key`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ teamId }),
        });

        if (res.status === 402) {
          error("Sync requires an active subscription.");
          process.exitCode = 1;
          return;
        }

        if (!res.ok) {
          const err = await res.text();
          error(`Failed to create API key: ${err}`);
          process.exitCode = 1;
          return;
        }

        const data: any = await res.json();
        saveConfig({ syncApiKey: data.apiKey, teamId: data.teamId });
        success(`API key created and saved: ${data.apiKey.slice(0, 12)}...`);
      } catch (err: unknown) {
        error(`Failed to create API key: ${getErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  // Provider sync commands (existing)
  for (const provider of SUPPORTED_PROVIDERS) {
    sync
      .command(provider)
      .description(`Sync data from ${provider.charAt(0).toUpperCase() + provider.slice(1)}`)
      .option("-l, --list", "List available resources without importing")
      .option("--import-all", "Import all available resources")
      .option("--json", "Output raw JSON")
      .action(async (options) => {
        try {
          await ensureConnectorAuth(provider);

          // Notion returns `{ pages, databases }` (the web app needs the split);
          // flatten both into the array contract the other providers use.
          const raw: any = await apiCall(getResourceEndpoint(provider), "GET");
          const items: Resource[] = Array.isArray(raw)
            ? raw
            : Array.isArray(raw?.pages) || Array.isArray(raw?.databases)
              ? [...(raw.pages || []), ...(raw.databases || [])]
              : [];

          if (options.json) {
            console.log(JSON.stringify(items, null, 2));
            return;
          }

          if (items.length === 0) {
            console.log(`No ${provider} resources found to sync.`);
            return;
          }

          if (options.list) {
            console.log(`\nAvailable ${provider} resources:\n`);
            items.forEach((r, i) => {
              const imported = r.imported ? " [imported]" : "";
              console.log(`  ${i + 1}. ${resourceName(r)}${imported}`);
            });
            console.log();
            return;
          }

          let toImport: Resource[];
          if (options.importAll) {
            toImport = items;
          } else {
            console.log(`\nSelect resources to import (comma-separated numbers, or 'all'):\n`);
            items.forEach((r, i) => {
              console.log(`  ${i + 1}. ${resourceName(r)}`);
            });
            console.log();
            const answer = await prompt("Import (numbers or 'all'): ");

            if (answer.trim().toLowerCase() === "all") {
              toImport = items;
            } else {
              const indices = answer
                .split(",")
                .map((s) => Number.parseInt(s.trim(), 10))
                .filter((n) => !Number.isNaN(n) && n > 0 && n <= items.length);
              toImport = indices.map((i) => items[i - 1]);
            }
          }

          if (toImport.length === 0) {
            console.log("No resources selected.");
            return;
          }

          let imported = 0;
          for (const resource of toImport) {
            try {
              await apiCall(getImportEndpoint(provider), "POST", resource);
              console.log(`  \u2713 Imported: ${resourceName(resource)}`);
              imported++;
            } catch (err: unknown) {
              console.log(`  \u2717 Failed: ${resource.name} \u2014 ${getErrorMessage(err)}`);
            }
          }

          console.log(`\nDone. ${imported}/${toImport.length} imported.\n`);
        } catch (err: unknown) {
          console.error(`Sync failed for ${provider}:`, getErrorMessage(err));
          process.exitCode = 1;
          return;
        }
      });
  }
}
