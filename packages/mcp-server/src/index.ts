#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import { AkgStorage } from "@astrivya/akg-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getByokProvider, getConfig } from "./api";
import { handleReadResource, handleToolCall, setAkgStorage, setToolPlugins } from "./handlers";
import { checkForUpdates, formatBanner } from "./lib/update-notifier";
import { CURRENT_VERSION } from "./lib/version";
import { loadToolPlugins } from "./plugin";
import { RESOURCE_DEFINITIONS, buildToolList } from "./schemas";

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
    try {
      const result = await handleToolCall(name, args);
      return result;
    } catch (err: unknown) {
      console.error(`[Astrivya MCP] Tool execution error for ${name}:`, err);
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
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

async function initAkg(): Promise<string> {
  const workspacePath = process.env.ASTRIVYA_WORKSPACE_PATH || process.cwd();
  const storage = new AkgStorage();
  await storage.init(workspacePath);
  setAkgStorage(storage, workspacePath);
  console.error(`[Astrivya MCP] Local AKG initialized at ${workspacePath}`);
  const stats = storage.getStats();
  if (stats.nodes === 0) {
    console.error("[Astrivya MCP] Workspace not yet indexed. Run `astrivya akg init` for richer queries.");
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

// Non-blocking: checks the npm registry once per day and prints a one-line
// banner to stderr (stdout is reserved for the MCP stdio protocol channel).
// Never crashes the server.
function maybePrintUpdateBanner(): void {
  void checkForUpdates().then((latest) => {
    if (latest) {
      console.error(formatBanner(CURRENT_VERSION, latest));
    }
  });
}

async function runStdioServer() {
  console.error("[Astrivya MCP Server] Starting up (stdio transport).");
  const byok = getByokProvider();
  if (byok) console.error(`[Astrivya MCP] BYOK provider: ${byok.name}`);
  await initAkg();
  maybePrintUpdateBanner();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Astrivya MCP Server is listening on Standard I/O.");
}

async function runHttpServer(port: number) {
  console.error(`[Astrivya MCP HTTP] Starting up on http://localhost:${port}/mcp`);
  const byok = getByokProvider();
  if (byok) console.error(`[Astrivya MCP] BYOK provider: ${byok.name}`);
  await initAkg();
  maybePrintUpdateBanner();

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const app = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
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
}

async function main() {
  const args = process.argv.slice(2);
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
