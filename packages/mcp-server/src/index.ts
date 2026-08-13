#!/usr/bin/env node
import crypto from "node:crypto";
import * as fs from "node:fs";
import http from "node:http";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { AkgEmbedder, AkgIndexer } from "@astrivya/akg-indexer";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import envPaths from "env-paths";
import { getByokProvider, getConfig } from "./api";
import { handleReadResource, handleToolCall, refreshContextDigest, setAkgStorage, setToolPlugins } from "./handlers";
import { maybeAutoUpdate } from "./lib/auto-update";
import { CURRENT_VERSION } from "./lib/version";
import { loadToolPlugins } from "./plugin";
import { RESOURCE_DEFINITIONS, buildToolList } from "./schemas";
import {
  getStatus,
  initStatus,
  recordEvent,
  recordServerStop,
  recordSessionEnd,
  recordSessionStart,
  recordToolCall,
} from "./status";

function createServer() {
  const server = new Server(
    { name: "astrivya-mcp-server", version: CURRENT_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const pluginTools = await loadToolPlugins();
    setToolPlugins(pluginTools);
    return { tools: buildToolList(pluginTools) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let ok = false;
    try {
      const result = await handleToolCall(name, args);
      ok = !(result as any)?.isError;
      return result;
    } catch (err: unknown) {
      console.error(`[Astrivya MCP] Tool execution error for ${name}:`, err);
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    } finally {
      recordToolCall(name, ok);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCE_DEFINITIONS,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    try {
      return await handleReadResource(uri);
    } catch (err: unknown) {
      console.error(`[Astrivya MCP] Resource read error for ${uri}:`, err);
      throw err;
    }
  });

  return server;
}

/**
 * Auto-index the workspace when the graph is empty (or chunk-less), so the
 * MCP is useful immediately — no manual `astrivya akg init` required.
 *
 * Modes (env `ASTRIVYA_AUTO_INDEX`):
 *   - `full` (default): index files + generate local ONNX embeddings.
 *   - `fast`: index files only, skip embeddings.
 *   - `off` (or `ASTRIVYA_NO_AUTO_INDEX=1`): never auto-index.
 *
 * A `.astrivya/index.lock` file prevents concurrent servers from indexing the
 * same workspace at once (stale locks older than 10 minutes are broken).
 * Indexing is incremental (content-hash based), so re-runs are cheap.
 */
async function maybeAutoIndex(storage: AkgStorage, workspacePath: string): Promise<void> {
  const mode = process.env.ASTRIVYA_AUTO_INDEX || "full";
  if (mode === "off" || process.env.ASTRIVYA_NO_AUTO_INDEX === "1") {
    console.error("[Astrivya MCP] Auto-index disabled (ASTRIVYA_AUTO_INDEX=off). Run `astrivya akg init` manually.");
    return;
  }

  const stats = storage.getStats();
  if (stats.nodes > 0 && stats.chunks > 0) return;

  const lockPath = path.join(workspacePath, ".astrivya", "index.lock");
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age < 10 * 60 * 1000) {
        console.error(
          "[Astrivya MCP] Another process is indexing this workspace (index.lock present). Skipping auto-index.",
        );
        return;
      }
      fs.unlinkSync(lockPath); // stale lock from a crashed run
    }
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    console.error(`[Astrivya MCP] Workspace not indexed - auto-indexing (ASTRIVYA_AUTO_INDEX=${mode})...`);
    const indexer = new AkgIndexer(storage, workspacePath);
    const result = await indexer.indexWorkspaceDetailed(
      (ev) => {
        if (ev.phase === "detect") {
          console.error(`[Astrivya MCP] ${ev.message ?? "Workspace scanned"}`);
        } else if (ev.phase === "code" && ev.unitStart && ev.unitName) {
          const total = ev.unitFilesTotal ? ` (${ev.unitFilesTotal} files)` : "";
          console.error(`[Astrivya MCP] Indexing ${ev.unitName} [${ev.unitKind ?? "unit"}]${total}...`);
        } else if (ev.phase === "code" && ev.unitComplete && ev.unitName) {
          console.error(
            `[Astrivya MCP] Indexed ${ev.unitName}: ${ev.unitFilesDone ?? 0}/${ev.unitFilesTotal ?? "?"} files, ${ev.chunks ?? 0} chunks total`,
          );
        } else if (ev.phase === "agent") {
          console.error("[Astrivya MCP] Indexing agent activity...");
        } else if (ev.phase === "todos") {
          console.error("[Astrivya MCP] Indexing TODO files...");
        } else if (ev.phase === "save") {
          console.error("[Astrivya MCP] Saving database...");
        }
      },
      { parallel: false },
    );
    console.error(
      `[Astrivya MCP] Auto-indexed ${result.filesIndexed} files -> ${result.nodesCreated} nodes, ${result.edgesCreated} edges, ${result.chunks} chunks.`,
    );

    if (mode === "full") {
      try {
        const embedder = new AkgEmbedder();
        const modelsDir = path.join(envPaths("astrivya", { suffix: "" }).config, "models");
        const emb = await embedder.embedAllChunks(storage, modelsDir, (done, total) => {
          if (done % 50 === 0 || done === total) console.error(`[Astrivya MCP] Embedding chunks ${done}/${total}...`);
        });
        console.error(`[Astrivya MCP] Embedded ${emb.embedded}/${emb.total} chunks.`);
      } catch (err: unknown) {
        console.error(
          `[Astrivya MCP] Embeddings skipped: ${err instanceof Error ? err.message : String(err)} (keyword search still works)`,
        );
      }
    }

    recordEvent(
      "auto_index",
      {
        mode,
        files: result.filesIndexed,
        nodes: result.nodesCreated,
        edges: result.edgesCreated,
        chunks: result.chunks,
      },
      workspacePath,
    );
  } catch (err: unknown) {
    console.error(`[Astrivya MCP] Auto-index failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // lock already gone — fine
    }
  }
}

async function initAkg(): Promise<string> {
  const workspacePath = process.env.ASTRIVYA_WORKSPACE_PATH || process.cwd();
  const storage = new AkgStorage();
  await storage.init(workspacePath);
  setAkgStorage(storage, workspacePath);
  console.error(`[Astrivya MCP] Local AKG initialized at ${workspacePath}`);
  const stats = storage.getStats();
  if (stats.nodes === 0 || stats.chunks === 0) {
    console.error("[Astrivya MCP] Workspace not yet indexed - auto-indexing...");
    await maybeAutoIndex(storage, workspacePath);
  } else {
    console.error(`[Astrivya MCP] AKG has ${stats.nodes} nodes, ${stats.edges} edges, ${stats.chunks} chunks`);
    if (!process.env.ASTRIVYA_TOKEN) {
      console.error("");
      console.error("  [Astrivya MCP] Your knowledge graph is growing. Want to share it with your team?");
      console.error(`  [Astrivya MCP] → Sign up free at ${getConfig().baseUrl}`);
      console.error("  [Astrivya MCP] → Or set ASTRIVYA_TOKEN for cloud sync.");
      console.error("");
    }
  }
  return workspacePath;
}

// Non-blocking: with ASTRIVYA_MCP_AUTO_UPDATE=1 newer same-major versions are
// installed in the background (takes effect on the next client launch);
// otherwise a one-line update banner is printed to stderr (stdout is reserved
// for the MCP stdio protocol channel). Never crashes the server.
function maybePrintUpdateBanner(): void {
  void maybeAutoUpdate();
}

async function runStdioServer() {
  console.error("[Astrivya MCP Server] Starting up (stdio transport).");
  const byok = getByokProvider();
  if (byok) console.error(`[Astrivya MCP] BYOK provider: ${byok.name}`);
  const workspacePath = await initAkg();
  refreshContextDigest();
  maybePrintUpdateBanner();

  initStatus({ workspace: workspacePath, mode: "stdio", version: CURRENT_VERSION });

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  recordSessionStart();
  console.error("Astrivya MCP Server is listening on Standard I/O.");

  const shutdown = (signal: string) => {
    recordServerStop(signal);
    void transport
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function runHttpServer(port: number) {
  console.error(`[Astrivya MCP HTTP] Starting up on http://localhost:${port}/mcp`);
  const byok = getByokProvider();
  if (byok) console.error(`[Astrivya MCP] BYOK provider: ${byok.name}`);
  const workspacePath = await initAkg();
  refreshContextDigest();
  maybePrintUpdateBanner();

  initStatus({ workspace: workspacePath, mode: "http", version: CURRENT_VERSION });

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: () => {
      recordSessionStart();
    },
    onsessionclosed: () => {
      recordSessionEnd();
    },
  });
  await server.connect(transport);

  const app = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      const status = getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: CURRENT_VERSION,
          uptimeMs: status.uptimeMs,
          pid: process.pid,
        }),
      );
      return;
    }
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...getStatus() }));
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[Astrivya MCP] Transport error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  });

  app.listen(port, () => {
    console.error(`[Astrivya MCP HTTP] Listening on http://localhost:${port}/mcp`);
  });

  const shutdown = (signal: string) => {
    recordServerStop(signal);
    app.close(() => {
      void transport
        .close()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  const args = process.argv.slice(2);

  const teamIndex = args.indexOf("--team");
  if (teamIndex !== -1 && args[teamIndex + 1]) {
    process.env.ASTRIVYA_TEAM_MCP = args[teamIndex + 1];
  }

  const httpIndex = args.indexOf("--http") !== -1 || args.indexOf("--sse") !== -1;
  if (httpIndex) {
    const portIndex = args.indexOf("--port");
    const port = portIndex !== -1 ? Number.parseInt(args[portIndex + 1], 10) : 3001;
    await runHttpServer(port);
  } else {
    await runStdioServer();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Astrivya MCP Server failed:", err);
    process.exit(1);
  });
}

export { runHttpServer, runStdioServer };
export { getStatus, journalPath, readJournal } from "./status";
