import { exec, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { AkgStorage, GraphTraversal, ImpactAnalyzer } from "@astrivya/akg-core";
import { AkgIndexer, Watcher } from "@astrivya/akg-indexer";
import { readJournal } from "@astrivya/mcp-server";
import type { Command } from "commander";
import { color, error, getErrorMessage, info } from "../lib/output";
import { isPidAlive, journalSessionRows } from "./mcp";

interface MeshSenderRow {
  id: string;
  name: string | null;
  model: string | null;
  provider: string | null;
  session: string | null;
  cwd: string | null;
  project: string | null;
  pid: number | null;
  lastSeen: string;
}

/**
 * When the MCP HTTP registry (ASTRIVYA_MCP_URL, default localhost:3001) is
 * unreachable, spawn `mcp-server --sse` as a child of Atlas so the live
 * sessions registry / status endpoints work out of the box. Local hosts only;
 * opt out with ASTRIVYA_ATLAS_NO_AUTO_MCP=1 or --no-auto-mcp.
 */
function maybeAutoStartMcpServer(mcpBase: string): void {
  let port = 3001;
  let host = "localhost";
  try {
    const u = new URL(mcpBase);
    host = u.hostname;
    port = Number(u.port) || 3001;
  } catch {
    // unparseable base — keep defaults
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    info(`MCP server at ${mcpBase} is remote — not auto-starting.`);
    return;
  }
  void (async () => {
    try {
      const probe = await fetch(`${mcpBase}/status`, { signal: AbortSignal.timeout(1500) });
      if (probe.ok) return;
    } catch {
      // unreachable — auto-start below
    }
    const child = spawn(
      process.execPath,
      [process.argv[1], "mcp-server", "--sse", "--port", String(port)],
      { stdio: "inherit" },
    );
    info(
      `MCP server unreachable at ${mcpBase} — auto-started \`astrivya mcp-server --sse --port ${port}\` (pid ${child.pid}).`,
    );
    child.on("error", (err) => error(`Auto-starting MCP server failed: ${getErrorMessage(err)}`));
    child.on("exit", (code) => info(`Auto-started MCP server exited (code ${code}).`));
    const killChild = (): void => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    process.once("SIGINT", killChild);
    process.once("SIGTERM", killChild);
    process.once("exit", killChild);
  })();
}

export function registerAtlas(program: Command): void {
  program
    .command("serve")
    .alias("atlas")
    .description("Start the local Atlas visual intelligence graph explorer")
    .option("-p, --port <port>", "Port to run the server on", "4200")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("--no-auto-mcp", "Skip auto-starting the MCP HTTP server when it is unreachable")
    .action(async (options) => {
      const port = Number.parseInt(options.port, 10);
      const workspacePath = path.resolve(options.workspace);

      const storage = new AkgStorage();
      try {
        await storage.init(workspacePath);
      } catch (err: unknown) {
        error(`Failed to initialize AKG storage: ${getErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }

      const staticDir = path.join(__dirname, "atlas");
      const activeClients: http.ServerResponse[] = [];

      const server = http.createServer((req, res) => {
        // CORS Headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        const url = new URL(req.url || "", `http://localhost:${port}`);
        const pathname = url.pathname;

        // Server-Sent Events endpoint
        if (pathname === "/api/akg/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          res.write(`data: ${JSON.stringify({ type: "init" })}\n\n`);
          activeClients.push(res);

          req.on("close", () => {
            const idx = activeClients.indexOf(res);
            if (idx !== -1) {
              activeClients.splice(idx, 1);
            }
          });
          return;
        }

        // API Endpoints
        if (pathname === "/api/mcp/status" || pathname === "/api/mcp/journal") {
          const mcpBase = (process.env.ASTRIVYA_MCP_URL || "http://localhost:3001").replace(/\/+$/, "");
          const upstream = pathname === "/api/mcp/status" ? "/status" : `/journal${url.search || ""}`;
          void (async () => {
            try {
              const upstreamRes = await fetch(`${mcpBase}${upstream}`, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(2500),
              });
              if (!upstreamRes.ok) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: `MCP server unreachable at ${mcpBase} (HTTP ${upstreamRes.status})`,
                    hint: "Start it with: astrivya mcp-server --sse --port 3001",
                  }),
                );
                return;
              }
              const body = await upstreamRes.text();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(body);
            } catch {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: `MCP server unreachable at ${mcpBase}`,
                  hint: "Start it with: astrivya mcp-server --sse --port 3001",
                }),
              );
            }
          })();
          return;
        }

        if (pathname === "/api/mcp/mesh") {
          // Agent Mesh feed — journal-direct (no live MCP server required).
          // Read the workspace journal, filter agent_message + agent_identify
          // events, and decorate senders with PID liveness.
          res.setHeader("Content-Type", "application/json");
          try {
            const events = readJournal(workspacePath, 5000);
            const messages = events
              .filter((e) => e.type === "agent_message")
              .map((e) => ({
                id: String(e.id ?? ""),
                from: String(e.from ?? e.session_id ?? ""),
                fromName: (e.from_name as string | null) ?? null,
                client: e.client ?? null,
                to: String(e.to ?? "all"),
                type: String(e.msg_type ?? "general"),
                text: String(e.text ?? ""),
                threadId: e.thread_id ?? null,
                inReplyTo: e.in_reply_to ?? null,
                context: e.context ?? null,
                urgency: String(e.urgency ?? "normal"),
                ts: String(e.ts),
                pid: typeof e.pid === "number" ? e.pid : null,
              }));
            const identityById = new Map<string, MeshSenderRow>();
            for (const e of events) {
              if (e.type !== "agent_identify") continue;
              const sid = String(e.session_id ?? "");
              if (!sid) continue;
              const existing = identityById.get(sid);
              identityById.set(sid, {
                id: sid,
                name: (e.name as string | null) ?? existing?.name ?? null,
                model: (e.model as string | null) ?? existing?.model ?? null,
                provider: (e.provider as string | null) ?? existing?.provider ?? null,
                session: (e.session as string | null) ?? existing?.session ?? null,
                cwd: (e.cwd as string | null) ?? existing?.cwd ?? null,
                project: (e.project as string | null) ?? existing?.project ?? null,
                pid: typeof e.pid === "number" ? e.pid : null,
                lastSeen: String(e.ts),
              });
            }
            for (const m of messages) {
              if (!identityById.has(m.from) && m.from) {
                identityById.set(m.from, {
                  id: m.from,
                  name: m.fromName,
                  model: null,
                  provider: null,
                  session: null,
                  cwd: null,
                  project: null,
                  pid: m.pid,
                  lastSeen: m.ts,
                });
              }
            }
            const senders: Array<MeshSenderRow & { alive: boolean }> = [...identityById.values()].map((s) => ({
              ...s,
              alive: isPidAlive(s.pid),
            }));
            senders.sort((a, b) => String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")));
            messages.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

            // All sessions ever seen in the journal, classified by PID
            // liveness (active / orphan / ended) — so the panel shows every
            // current running session even without a live HTTP server.
            const startById = new Map<string, Record<string, unknown>>();
            for (const e of events) {
              if (e.type !== "session_start") continue;
              const sid = e.session_id ? `sid:${String(e.session_id)}` : `pid:${String(e.pid ?? "?")}`;
              startById.set(sid, e);
            }
            const sessions = journalSessionRows(events).map((r) => {
              const key = r.legacy ? `pid:${String(r.pid ?? "?")}` : `sid:${r.id}`;
              const startEv = startById.get(key);
              const ident = identityById.get(r.id);
              return {
                id: r.id,
                client: (startEv?.client as string | null) ?? r.client,
                clientVersion: (startEv?.client_version as string | null) ?? null,
                mode: (startEv?.mode as string | null) ?? null,
                pid: r.pid,
                legacy: r.legacy,
                state: r.state,
                toolCalls: r.toolCalls,
                lastTool: r.lastTool,
                startedAt: startEv ? new Date(String(startEv.ts)).getTime() : null,
                lastActiveAt: r.lastTs,
                agent: ident
                  ? {
                      name: ident.name,
                      model: ident.model,
                      provider: ident.provider,
                      session: ident.session,
                      project: ident.project,
                    }
                  : null,
              };
            });
            sessions.sort((a, b) => {
              const rank = { active: 0, orphan: 1, ended: 2 } as const;
              if (rank[a.state as keyof typeof rank] !== rank[b.state as keyof typeof rank]) {
                return rank[a.state as keyof typeof rank] - rank[b.state as keyof typeof rank];
              }
              return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
            });
            const running = sessions.filter((s) => s.state === "active").length;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                messages,
                senders,
                sessions,
                count: messages.length,
                activeAgents: running,
              }),
            );
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Mesh read failed: ${getErrorMessage(err)}` }));
          }
          return;
        }

        if (pathname.startsWith("/api/akg/")) {
          res.setHeader("Content-Type", "application/json");

          try {
            if (pathname === "/api/akg/graph") {
              // Explicit columns only — the nodes table has a `content` TEXT
              // column holding full file source. `SELECT *` shipped entire file
              // bodies to the browser on every graph load (10-100x payload).
              const nodes = storage.runQuery(
                "SELECT id, label, type, source_file, community, churn_rate, contributor_count, created_at, updated_at FROM nodes;",
              );
              const edges = storage.runQuery("SELECT source, target, relation, weight FROM edges;");
              res.writeHead(200);
              res.end(JSON.stringify({ nodes, edges }));
              return;
            }

            if (pathname === "/api/akg/node") {
              const id = url.searchParams.get("id");
              if (!id) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Missing node id" }));
                return;
              }
              const node = storage.getNode(id);
              if (!node) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "Node not found" }));
                return;
              }
              const neighbors = storage.getNeighbors(id);
              res.writeHead(200);
              res.end(JSON.stringify({ node, neighbors }));
              return;
            }

            if (pathname === "/api/akg/subgraph") {
              const id = url.searchParams.get("id");
              const radius = Number.parseInt(url.searchParams.get("radius") || "2", 10);
              if (!id) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Missing node id" }));
                return;
              }

              const centerNode = storage.getNode(id);
              if (!centerNode) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "Center node not found" }));
                return;
              }

              // BFS undirected graph extraction
              const visited = new Set<string>([id]);
              const queue = [{ id, depth: 0 }];
              const subgraphNodes = new Map<string, any>();
              const subgraphEdges = new Map<string, any>();

              subgraphNodes.set(id, centerNode);

              while (queue.length > 0) {
                const { id: currId, depth } = queue.shift()!;
                if (depth >= radius) continue;

                const neighbors = storage.getNeighbors(currId);
                for (const n of neighbors) {
                  if (!subgraphNodes.has(n.node.id)) {
                    subgraphNodes.set(n.node.id, n.node);
                  }

                  const source = n.direction === "out" ? currId : n.node.id;
                  const target = n.direction === "out" ? n.node.id : currId;
                  const edgeKey = `${source}➔${target}➔${n.relation}`;

                  if (!subgraphEdges.has(edgeKey)) {
                    subgraphEdges.set(edgeKey, {
                      source,
                      target,
                      relation: n.relation,
                    });
                  }

                  if (!visited.has(n.node.id)) {
                    visited.add(n.node.id);
                    queue.push({ id: n.node.id, depth: depth + 1 });
                  }
                }
              }

              res.writeHead(200);
              res.end(
                JSON.stringify({
                  nodes: Array.from(subgraphNodes.values()),
                  edges: Array.from(subgraphEdges.values()),
                }),
              );
              return;
            }

            if (pathname === "/api/akg/search") {
              const q = (url.searchParams.get("q") || "").toLowerCase();
              // Explicit columns only — same rationale as /api/akg/graph:
              // the nodes table has a `content` column holding full file
              // source; SELECT * would ship entire file bodies per hit.
              const nodes = storage.runQuery(
                "SELECT id, label, type, source_file, community, churn_rate, contributor_count, created_at, updated_at FROM nodes WHERE LOWER(label) LIKE ? OR LOWER(id) LIKE ? LIMIT 50;",
                [`%${q}%`, `%${q}%`],
              );
              res.writeHead(200);
              res.end(JSON.stringify(nodes));
              return;
            }

            if (pathname === "/api/akg/impact") {
              const id = url.searchParams.get("id");
              if (!id) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Missing node id" }));
                return;
              }
              const analyzer = new ImpactAnalyzer(storage);
              const report = analyzer.analyzeRemoval(id);
              const cycles = analyzer.findCycles(5);

              if (!report) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "Node not found for impact analysis" }));
                return;
              }

              res.writeHead(200);
              res.end(JSON.stringify({ report, cycles }));
              return;
            }

            if (pathname === "/api/akg/path") {
              const from = url.searchParams.get("from");
              const to = url.searchParams.get("to");
              if (!from || !to) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Missing from or to node ids" }));
                return;
              }
              const traversal = new GraphTraversal(storage);
              const pathResult = traversal.shortestPath(from, to);
              res.writeHead(200);
              res.end(JSON.stringify(pathResult));
              return;
            }

            if (pathname === "/api/akg/topo") {
              const traversal = new GraphTraversal(storage);
              const result = traversal.topologicalSort(["imports", "depends_on"], ["file"]);
              const entries = result.entries.map((e) => ({
                node: {
                  id: e.node.id,
                  label: e.node.label,
                  type: e.node.type,
                  sourceFile: e.node.sourceFile,
                  sourceLocation: e.node.sourceLocation,
                  createdAt: e.node.createdAt,
                  updatedAt: e.node.updatedAt,
                },
                depth: e.depth,
              }));
              res.writeHead(200);
              res.end(JSON.stringify({ entries, cycleNodeIds: result.cycleNodeIds }));
              return;
            }

            if (pathname === "/api/akg/stats") {
              const stats = storage.getStats();
              res.writeHead(200);
              res.end(JSON.stringify(stats));
              return;
            }

            if (pathname === "/api/akg/communities") {
              const rows = storage.runQuery("SELECT DISTINCT community FROM nodes WHERE community IS NOT NULL;");
              const comms = rows.map((r) => {
                const commId = r.community;
                const label = getCommunityLabel(storage, commId);
                const count = storage.runQuery("SELECT COUNT(*) as cnt FROM nodes WHERE community = ?;", [commId])[0]
                  .cnt;
                return { id: commId, label, nodeCount: count };
              });
              res.writeHead(200);
              res.end(JSON.stringify(comms));
              return;
            }

            if (pathname === "/api/akg/embedmap") {
              // PCA 2D projection of chunk embeddings — the "semantic
              // terrain" of the workspace. Points carry their file, node id,
              // community and a content preview for hover inspection.
              const rows = storage.runQuery(
                `SELECT e.chunk_id, e.vector, c.file_path, c.content, c.node_id, n.community
                 FROM embeddings e
                 JOIN chunks c ON c.id = e.chunk_id
                 LEFT JOIN nodes n ON n.id = c.node_id
                 ORDER BY c.id
                 LIMIT 4000;`,
              );
              const vectors: number[][] = [];
              const meta: any[] = [];
              for (const r of rows || []) {
                if (!r.vector) continue;
                const raw = r.vector instanceof Uint8Array ? r.vector : new Uint8Array(r.vector);
                const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
                vectors.push(Array.from(floats));
                meta.push({
                  chunkId: r.chunk_id,
                  file: r.file_path,
                  nodeId: r.node_id,
                  community: r.community ?? null,
                  preview: String(r.content || "").slice(0, 140),
                });
              }
              if (vectors.length < 3) {
                res.writeHead(200);
                res.end(
                  JSON.stringify({
                    points: [],
                    count: 0,
                    note: "Not enough embeddings yet — run `astrivya akg init` with embeddings.",
                  }),
                );
                return;
              }
              const projected = pca2(vectors);
              let minX = Number.POSITIVE_INFINITY;
              let maxX = Number.NEGATIVE_INFINITY;
              let minY = Number.POSITIVE_INFINITY;
              let maxY = Number.NEGATIVE_INFINITY;
              for (const [x, y] of projected) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
              const rx = maxX - minX || 1;
              const ry = maxY - minY || 1;
              const points = projected.map(([x, y], i) => ({
                x: (x - minX) / rx,
                y: (y - minY) / ry,
                ...meta[i],
              }));
              res.writeHead(200);
              res.end(JSON.stringify({ points, count: points.length }));
              return;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: "Endpoint not found" }));
            return;
          } catch (err: unknown) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: getErrorMessage(err) }));
            return;
          }
        }

        // Serve Static Files
        let filePath = path.join(staticDir, pathname === "/" ? "index.html" : pathname);

        // Fallback for client side React router
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          filePath = path.join(staticDir, "index.html");
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".gif": "image/gif",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
        };

        const contentType = mimeTypes[ext] || "application/octet-stream";

        fs.readFile(filePath, (err, content) => {
          if (err) {
            res.writeHead(500);
            res.end(`Server Error: ${err.code}`);
          } else {
            res.writeHead(200, { "Content-Type": contentType });
            res.end(content, "utf-8");
          }
        });
      });

      server.listen(port, () => {
        const url = `http://localhost:${port}`;
        info(`\n🚀 ${color.bold("Astrivya Atlas serving active at:")} ${color.cyan(url)}`);
        info(`   Database workspace: ${color.dim(workspacePath)}\n`);

        // Start file watcher (shared Watcher: debounced, noise-filtered).
        // Changes are indexed incrementally and pushed to SSE clients.
        const indexer = new AkgIndexer(storage, workspacePath);
        const watcher = new Watcher(
          async (files) => {
            for (const file of files) {
              try {
                const wasUpdated = await indexer.indexFile(file);
                if (wasUpdated) {
                  const rel = path.relative(workspacePath, file).replace(/\\/g, "/");
                  const updateMsg = `data: ${JSON.stringify({ type: "update", file: rel })}\n\n`;
                  activeClients.forEach((client) => client.write(updateMsg));
                }
              } catch {
                // silent warning for busy files
              }
            }
          },
          { onError: (err) => info(`File watcher error: ${getErrorMessage(err)}`) },
        );
        if (!watcher.start(workspacePath)) {
          info("File watcher failed to start — graph updates are manual (`astrivya akg reindex`).");
        }
        process.once("SIGINT", () => watcher.stop());

        // Auto-start the MCP HTTP server when unreachable (--no-auto-mcp / env opt-out)
        if (options.autoMcp !== false && process.env.ASTRIVYA_ATLAS_NO_AUTO_MCP !== "1") {
          const mcpBase = (process.env.ASTRIVYA_MCP_URL || "http://localhost:3001").replace(/\/+$/, "");
          maybeAutoStartMcpServer(mcpBase);
        }

        // Auto-open browser
        const cmd =
          process.platform === "win32"
            ? `start ${url}`
            : process.platform === "darwin"
              ? `open ${url}`
              : `xdg-open ${url}`;

        exec(cmd, (err) => {
          if (err) {
            info(`Could not open browser automatically. Please open ${url} in your browser.`);
          }
        });
      });
    });
}

// PCA projection of high-dim vectors to 2D via power iteration on the
// covariance operator (X^T X v). Avoids materializing the d×d covariance
// matrix, so it is fine for a few thousand 384-dim vectors.
export function pca2(vectors: number[][]): number[][] {
  const n = vectors.length;
  const d = vectors[0].length;
  const mean = new Array(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const centered = vectors.map((v) => v.map((x, i) => x - mean[i]));

  const normalize = (v: number[]): number[] => {
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm === 0) return new Array(v.length).fill(0);
    return v.map((x) => x / norm);
  };

  const powerIteration = (rows: number[][], seed: number[]): number[] => {
    let pc = seed;
    for (let it = 0; it < 25; it++) {
      const out = new Array(d).fill(0);
      for (const row of rows) {
        let dot = 0;
        for (let i = 0; i < d; i++) dot += row[i] * pc[i];
        for (let i = 0; i < d; i++) out[i] += row[i] * dot;
      }
      pc = normalize(out);
    }
    return pc;
  };

  const pc1 = powerIteration(centered, new Array(d).fill(1));
  const project = (row: number[], pc: number[]): number => {
    let dot = 0;
    for (let i = 0; i < d; i++) dot += row[i] * pc[i];
    return dot;
  };
  const x = centered.map((row) => project(row, pc1));

  // Deflate PC1, then find PC2 on the residual.
  const residual = centered.map((row) => {
    const p = project(row, pc1);
    return row.map((v, i) => v - p * pc1[i]);
  });
  const pc2 = powerIteration(
    residual,
    Array.from({ length: d }, (_, i) => (i % 2 === 0 ? 1 : -1)),
  );
  const y = residual.map((row) => project(row, pc2));

  return x.map((xi, i) => [xi, y[i]]);
}

// Custom community labeling logic based on folder prefixes and keyword analysis
function getCommunityLabel(storage: AkgStorage, communityId: number): string {
  const nodes = storage.runQuery(
    "SELECT label, source_file FROM nodes WHERE community = ? AND source_file IS NOT NULL;",
    [communityId],
  );
  if (nodes.length === 0) return `Community ${communityId}`;

  const dirs = new Map<string, number>();
  const keywords = new Map<string, number>();

  for (const n of nodes) {
    const dir = path.dirname(n.source_file || "").replace(/\\/g, "/");
    if (dir && dir !== ".") {
      dirs.set(dir, (dirs.get(dir) || 0) + 1);
    }
    const name = (n.label || "").replace(/\.(ts|js|tsx|jsx)$/i, "");
    const parts = name.split(/(?=[A-Z])|[-_\s]/);
    for (const p of parts) {
      const word = p.toLowerCase();
      if (word.length > 3) {
        keywords.set(word, (keywords.get(word) || 0) + 1);
      }
    }
  }

  let topDir = "";
  let maxDirCount = 0;
  for (const [d, count] of dirs.entries()) {
    if (count > maxDirCount) {
      maxDirCount = count;
      topDir = d;
    }
  }

  let topKeyword = "";
  let maxKeyCount = 0;
  for (const [k, count] of keywords.entries()) {
    if (count > maxKeyCount) {
      maxKeyCount = count;
      topKeyword = k;
    }
  }

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const displayKeyword = topKeyword ? capitalize(topKeyword) : "Module";
  const displayDir = topDir ? ` (/${topDir})` : "";
  return `${displayKeyword} Component${displayDir}`;
}
