import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { AkgStorage, GraphTraversal, ImpactAnalyzer } from "@astrivya/akg-core";
import { AkgIndexer } from "@astrivya/akg-indexer";
import type { Command } from "commander";
import { color, error, getErrorMessage, info } from "../lib/output";

export function registerAtlas(program: Command): void {
  program
    .command("serve")
    .alias("atlas")
    .description("Start the local Atlas visual intelligence graph explorer")
    .option("-p, --port <port>", "Port to run the server on", "4200")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
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

        // Start file watcher
        let debounceTimer: NodeJS.Timeout | null = null;
        const pendingChanges = new Set<string>();
        const ignoredExtensions = new Set([".json", ".lock", ".db", ".log", ".tmp"]);

        try {
          fs.watch(workspacePath, { recursive: true }, (_event, filename) => {
            if (!filename) return;

            const parts = filename.replace(/\\/g, "/").split("/");
            if (
              parts.some(
                (p) =>
                  p.startsWith(".") ||
                  p === "node_modules" ||
                  p === "dist" ||
                  p === "out" ||
                  p === "coverage" ||
                  p === "graphify-out" ||
                  p === ".astrivya",
              )
            ) {
              return;
            }

            const ext = path.extname(filename).toLowerCase();
            if (ignoredExtensions.has(ext)) return;

            const fullPath = path.join(workspacePath, filename);

            // Check if file still exists on disk
            if (!fs.existsSync(fullPath)) return;
            try {
              if (!fs.statSync(fullPath).isFile()) return;
            } catch {
              return;
            }

            pendingChanges.add(fullPath);

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
              const changes = Array.from(pendingChanges);
              pendingChanges.clear();

              const indexer = new AkgIndexer(storage, workspacePath);

              for (const file of changes) {
                try {
                  const wasUpdated = await indexer.indexFile(file);
                  if (wasUpdated) {
                    const rel = path.relative(workspacePath, file).replace(/\\/g, "/");
                    const updateMsg = `data: ${JSON.stringify({ type: "update", file: rel })}\n\n`;
                    activeClients.forEach((client) => client.write(updateMsg));
                  }
                } catch (_err: unknown) {
                  // silent warning for busy files
                }
              }
            }, 600);
          });
        } catch (err: unknown) {
          info(`File watcher failed to start: ${getErrorMessage(err)}`);
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
function pca2(vectors: number[][]): number[][] {
  const n = vectors.length;
  const d = vectors[0].length;
  const mean = new Array(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const centered = vectors.map((v) => v.map((x, i) => x - mean[i]));

  const normalize = (v: number[]): number[] => {
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
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

  const pc1 = powerIteration(
    centered,
    centered.map(() => 1),
  );
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
    residual.map((_, i) => (i % 2 === 0 ? 1 : -1)),
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
