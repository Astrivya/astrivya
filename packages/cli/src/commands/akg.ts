import * as fs from "node:fs";
import * as path from "node:path";
import {
  AkgQuery,
  AkgStorage,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  GraphTraversal,
  ImpactAnalyzer,
} from "@astrivya/akg-core";
import { AkgEmbedder, AkgIndexer } from "@astrivya/akg-indexer";
import type { Command } from "commander";
import envPaths from "env-paths";
import { getBaseUrl, getOrgId, getToken } from "../lib/compat";
import { createIndexRenderer } from "../lib/index-progress";
import { color, error, getErrorMessage, success, warn } from "../lib/output";

/** Generate embeddings for all un-embedded chunks. Returns null if unavailable (FTS-only fallback). */
async function embedChunks(
  storage: AkgStorage,
  onProgress?: (done: number, total: number) => void,
): Promise<{ embedded: number; total: number; failed: number } | null> {
  try {
    const embedder = new AkgEmbedder();
    const pathsFromEnv = envPaths("astrivya", { suffix: "" });
    const modelsDir = path.join(pathsFromEnv.config, "models");
    return await embedder.embedAllChunks(storage, modelsDir, onProgress);
  } catch (err: unknown) {
    return null;
  }
}

/**
 * Push chunk embeddings to the team cloud graph (`/api/akg/sync/push`).
 * No-op unless the user is authenticated and belongs to an org — sync is an
 * explicit, tier-gated optional extra, so it must never break indexing.
 */
async function pushChunkEmbeddings(storage: AkgStorage): Promise<void> {
  const token = getToken();
  const baseUrl = getBaseUrl();
  const orgId = getOrgId();
  if (!token || !orgId || !baseUrl) {
    warn(
      "Cloud sync skipped: authenticate (`astrivya auth login`) and join/create a team (`astrivya team create|join`) first.",
    );
    return;
  }

  const rows = storage.runQuery(`
    SELECT c.id, c.node_id, c.file_path, c.start_line, c.end_line, c.content, e.vector
    FROM chunks c
    LEFT JOIN embeddings e ON e.chunk_id = c.id
  `);

  const nodes = (rows || []).map((c: any) => {
    let embedding: number[] | undefined;
    if (c.vector) {
      const raw = c.vector instanceof Uint8Array ? c.vector : new Uint8Array(c.vector);
      const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      embedding = Array.from(floats);
    }
    return {
      id: c.id,
      label: `chunk:${c.file_path}`,
      type: "chunk",
      content: c.content,
      metadata: {
        filePath: c.file_path,
        startLine: c.start_line ?? null,
        endLine: c.end_line ?? null,
      },
      ...(embedding ? { embedding, embedding_model: EMBEDDING_MODEL, embedding_dim: EMBEDDING_DIM } : {}),
    };
  });

  try {
    const res = await fetch(`${baseUrl}/api/akg/sync/push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ org_id: orgId, nodes, full_sync: true }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 402) {
        warn("Cloud team sync requires an active Pro subscription — pushed locally only.");
      } else {
        warn(`Cloud sync failed (${res.status}): ${text.slice(0, 200)}`);
      }
      return;
    }
    const result = (await res.json()) as { nodesCreated?: number; nodesUpdated?: number };
    success(`Cloud sync pushed ${result.nodesCreated ?? 0} new, ${result.nodesUpdated ?? 0} updated chunks.`);
  } catch (err: unknown) {
    warn(`Cloud sync unreachable: ${getErrorMessage(err)}`);
  }
}

export function registerAkg(program: Command): void {
  const akg = program.command("akg").description("Manage local repository knowledge graph (AKG)");

  akg
    .command("init [workspacePath]")
    .description("Initialize and index workspace files (code, docs, ADRs, agent logs) into local akg.db")
    .option("--no-embed", "Skip generating vector embeddings locally (ONNX)")
    .option("--no-parallel", "Index units sequentially (default: adaptive parallel workers)")
    .option("--sync", "Push chunk embeddings to your Astrivya team cloud graph after indexing")
    .action(async (workspacePath, options) => {
      const targetPath = workspacePath ? path.resolve(workspacePath) : process.cwd();
      const renderer = createIndexRenderer();
      try {
        const storage = new AkgStorage();
        await storage.init(targetPath);

        const indexer = new AkgIndexer(storage, targetPath);
        const result = await indexer.indexWorkspaceDetailed((ev) => renderer.update(ev), {
          parallel: options.parallel !== false,
        });

        let embResult: { embedded: number; total: number; failed: number } | null = null;
        if (options.embed !== false) {
          embResult = await embedChunks(storage, (done, total) => renderer.embed(done, total));
        }

        renderer.done(
          result,
          embResult
            ? { embedded: embResult.embedded, embeddedTotal: embResult.total }
            : options.embed === false
              ? {}
              : { embedSkipped: "local ONNX model unavailable" },
        );
        if (options.sync) {
          await pushChunkEmbeddings(storage);
        }
      } catch (err: unknown) {
        renderer.fail(getErrorMessage(err));
        process.exit(1);
      }
    });

  akg
    .command("status")
    .description("Show database stats and counts")
    .action(async () => {
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const stats = storage.getStats();

        console.log(`\n${color.bold("Astrivya Knowledge Graph (AKG) Status")}\n`);
        console.log(`  Nodes:       ${color.cyan(String(stats.nodes))}`);
        console.log(`  Edges:       ${color.cyan(String(stats.edges))}`);
        console.log(`  Chunks:      ${color.cyan(String(stats.chunks))}`);
        console.log(`  Embeddings:  ${color.cyan(String(stats.embeddings))}`);
        console.log(`  Communities: ${color.cyan(String(stats.communities))}`);
        console.log(`  DB Size:     ${color.cyan(`${(stats.dbSize / 1024 / 1024).toFixed(2)} MB`)}`);
        console.log();
        if (stats.nodes > 50) {
          console.log(
            `  ${color.dim("Your knowledge graph has")} ${color.cyan(String(stats.nodes))} ${color.dim("nodes — enough to power team context.")}`,
          );
          console.log(
            `  ${color.dim("Run")} ${color.cyan("astrivya auth login")} ${color.dim("to sync with your team via Astrivya Cloud.")}`,
          );
          console.log(`  ${color.dim("→")} ${color.cyan("https://astrivya.ai")}`);
          console.log();
        }
      } catch (err: unknown) {
        error(`Failed to read AKG status: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  akg
    .command("query <question>")
    .description("Run the hybrid retrieval pipeline against the AKG")
    .action(async (question) => {
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());

        const queryEngine = new AkgQuery(storage, process.cwd());
        const results = await queryEngine.retrieve(question);

        console.log(`\n${color.bold("AKG Query Results:")}\n`);
        if (results.length === 0) {
          console.log("  No matches found.");
          return;
        }
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const rank = i + 1;
          const loc = r.startLine ? `:${r.startLine}-${r.endLine}` : "";
          console.log(
            `  ${color.green(`[${rank}]`)} ${color.bold(r.filePath)}${loc} (score: ${r.score.toFixed(2)}, source: ${r.source})`,
          );
          console.log(`  ${color.dim("â”€".repeat(40))}`);
          const snippet = r.content.length > 200 ? `${r.content.slice(0, 200)}...` : r.content;
          console.log(
            snippet
              .split("\n")
              .map((l) => `    ${l}`)
              .join("\n"),
          );
          console.log();
        }
      } catch (err: unknown) {
        error(`Failed to execute AKG query: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  akg
    .command("reindex")
    .description("Incremental index updates for changed files (with embeddings)")
    .option("--no-embed", "Skip generating vector embeddings locally (ONNX)")
    .option("--no-parallel", "Index units sequentially (default: adaptive parallel workers)")
    .option("--sync", "Push chunk embeddings to your Astrivya team cloud graph after reindexing")
    .action(async (options) => {
      const targetPath = process.cwd();
      const renderer = createIndexRenderer();
      try {
        const storage = new AkgStorage();
        await storage.init(targetPath);

        const indexer = new AkgIndexer(storage, targetPath);
        const result = await indexer.indexWorkspaceDetailed((ev) => renderer.update(ev), {
          parallel: options.parallel !== false,
        });

        let embResult: { embedded: number; total: number; failed: number } | null = null;
        if (options.embed !== false) {
          embResult = await embedChunks(storage, (done, total) => renderer.embed(done, total));
        }

        renderer.done(
          result,
          embResult
            ? { embedded: embResult.embedded, embeddedTotal: embResult.total }
            : options.embed === false
              ? {}
              : { embedSkipped: "local ONNX model unavailable" },
        );
        if (options.sync) {
          await pushChunkEmbeddings(storage);
        }
      } catch (err: unknown) {
        renderer.fail(getErrorMessage(err));
        process.exit(1);
      }
    });

  akg
    .command("impact <filePath>")
    .description("Analyze the blast radius and risk score of modifying or removing a file")
    .action(async (filePath) => {
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());

        const relativePath = path.relative(process.cwd(), path.resolve(filePath)).replace(/\\/g, "/");
        const fileNodeId = `file::${relativePath}`;

        const analyzer = new ImpactAnalyzer(storage);
        const report = analyzer.analyzeRemoval(fileNodeId);

        if (!report) {
          error(`File "${filePath}" (node ID: "${fileNodeId}") not found in index. Run "astrivya akg init" first.`);
          process.exit(1);
        }

        console.log(`\n${color.bold("AKG Change Impact Analysis")}\n`);
        console.log(`  Target File:       ${color.cyan(filePath)}`);
        console.log(`  Directly Affected: ${color.yellow(String(report.directlyAffected.length))} files/functions`);
        console.log(
          `  Total Affected:    ${color.yellow(String(report.directlyAffected.length + report.transitivelyAffected.length))} nodes`,
        );
        console.log(
          `  Change Risk Score: ${report.riskScore > 0.7 ? color.red(report.riskScore.toFixed(2)) : report.riskScore > 0.4 ? color.yellow(report.riskScore.toFixed(2)) : color.green(report.riskScore.toFixed(2))} / 1.0`,
        );
        console.log(`  Summary:           ${report.summary}\n`);

        if (report.directlyAffected.length > 0) {
          console.log(color.bold("  Direct Impact (1-hop dependents):"));
          for (const d of report.directlyAffected) {
            console.log(`    â€¢ [${d.type}] ${color.cyan(d.id)}`);
          }
          console.log();
        }

        if (report.transitivelyAffected.length > 0) {
          console.log(color.bold("  Transitive Impact (multi-hop):"));
          const printLimit = 15;
          const toPrint = report.transitivelyAffected.slice(0, printLimit);
          for (const t of toPrint) {
            console.log(`    â€¢ [${t.type}] ${color.dim(t.id)}`);
          }
          if (report.transitivelyAffected.length > printLimit) {
            console.log(`    ... and ${report.transitivelyAffected.length - printLimit} more nodes.`);
          }
          console.log();
        }

        const cycles = analyzer.findCycles(5);
        if (cycles.length > 0) {
          console.log(`${color.red(color.bold("  Circular Dependency Loops Detected:"))}`);
          for (const c of cycles.slice(0, 5)) {
            console.log(`    â€¢ ${c.path.join(" âž” ")}`);
          }
          console.log();
        }
      } catch (err: unknown) {
        error(`Failed to analyze impact: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  akg
    .command("trace <source> <target>")
    .description("Find the shortest relationship pathway from source symbol/file to target")
    .action(async (source, target) => {
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());

        const traversal = new GraphTraversal(storage);

        const resolveNodeId = (name: string): string => {
          if (fs.existsSync(name)) {
            const rel = path.relative(process.cwd(), path.resolve(name)).replace(/\\/g, "/");
            return `file::${rel}`;
          }
          return name;
        };

        const srcId = resolveNodeId(source);
        const tgtId = resolveNodeId(target);

        const pathResult = traversal.shortestPath(srcId, tgtId);

        console.log(`\n${color.bold("AKG Relationship Trace Pathway")}\n`);
        console.log(`  Source: ${color.cyan(srcId)}`);
        console.log(`  Target: ${color.cyan(tgtId)}\n`);

        if (!pathResult) {
          console.log("  No relationship path found between the target nodes.");
          return;
        }

        console.log(`  Path length: ${pathResult.nodes.length} nodes (weight: ${pathResult.totalWeight})`);
        console.log("  Pathway:\n");

        for (let i = 0; i < pathResult.nodes.length; i++) {
          const node = pathResult.nodes[i];
          const edge = pathResult.edges[i];

          const connector = edge ? `  ${color.yellow(`â”€â”€[${edge.relation}]â”€â”€âž”`)}` : "";
          console.log(`    ${color.green(`[${node.type}]`)} ${color.bold(node.label)} (${color.dim(node.id)})`);
          if (connector) console.log(connector);
        }
        console.log();
      } catch (err: unknown) {
        error(`Failed to trace path: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  akg
    .command("export [outputFile]")
    .description("Export the local AKG database to a portable JSON file")
    .action(async (outputFile) => {
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const graph = storage.exportGraph();
        const outPath = outputFile || "akg-export.json";
        fs.writeFileSync(outPath, JSON.stringify(graph, null, 2));
        success(`Exported AKG to ${outPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
      } catch (err: unknown) {
        error(`Failed to export AKG: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  akg
    .command("import <inputFile>")
    .description("Import data from an AKG JSON export into the local database")
    .action(async (inputFile) => {
      try {
        const resolvedPath = path.resolve(inputFile);
        if (!fs.existsSync(resolvedPath)) {
          error(`File not found: ${inputFile}`);
          process.exit(1);
        }
        const raw = fs.readFileSync(resolvedPath, "utf-8");
        const data = JSON.parse(raw);
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const result = storage.importGraph(data);
        success(`Imported from ${inputFile}: ${result.merged} merged, ${result.conflicts} conflicts`);
      } catch (err: unknown) {
        error(`Failed to import AKG: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
