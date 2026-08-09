import * as path from "node:path";
import envPaths from "env-paths";
import type { AkgStorage } from "./akg-storage";
import type { QueryIntent, RetrievalResult } from "./akg-types";

let _embedderWarned = false;

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export class AkgQuery {
  private embedder: any = null;

  constructor(
    private storage: AkgStorage,
    _workspacePath: string,
  ) {}

  /** Attach freshness metadata (created/lastVerified/stale) to a candidate. */
  private enrichFreshness<T extends { createdAt?: number; lastVerifiedAt?: number; stale?: boolean }>(
    r: T,
    createdAt?: number | null,
    updatedAt?: number | null,
  ): T {
    r.createdAt = createdAt ?? undefined;
    r.lastVerifiedAt = updatedAt ?? undefined;
    r.stale = typeof updatedAt === "number" ? Date.now() - updatedAt > STALE_MS : undefined;
    return r;
  }

  private recencyBoost(updatedAt?: number): number {
    if (!updatedAt) return 1;
    const age = Date.now() - updatedAt;
    if (age <= 0) return 1;
    return Math.max(0.5, 1 / (1 + age / STALE_MS));
  }

  private async getEmbedder(): Promise<any> {
    if (this.embedder) return this.embedder;
    try {
      const mod = require("@astrivya/akg-indexer");
      const AkgEmbedder = mod.AkgEmbedder;
      const paths = envPaths("astrivya", { suffix: "" });
      const modelsDir = path.join(paths.config, "models");

      const emb = new AkgEmbedder();
      await emb.init(modelsDir);
      this.embedder = emb;
      return this.embedder;
    } catch (err: unknown) {
      // The most common cause of a dead semantic search is a standalone
      // install that does not ship @astrivya/akg-indexer. Surface it once so
      // an empty result is not mistaken for "no data".
      const msg = err instanceof Error ? err.message : String(err);
      if (/Cannot find module/.test(msg) && !_embedderWarned) {
        _embedderWarned = true;
        console.error(
          "[Astrivya] Semantic search unavailable: @astrivya/akg-indexer is not installed here. Keyword (FTS) search still works. Install it with: npm i -g @astrivya/akg-indexer",
        );
      } else if (msg && !_embedderWarned) {
        _embedderWarned = true;
        console.error(`[Astrivya] Semantic search unavailable: ${msg} — falling back to keyword (FTS) search.`);
      }
      this.embedder = null;
      return null;
    }
  }

  /** Whether the semantic embedder is available in this runtime. */
  async semanticAvailable(): Promise<boolean> {
    return !!(await this.getEmbedder());
  }

  /**
   * Embed a bare text with the local embedder, or `[]` when unavailable.
   * Used to turn an ad-hoc query into a vector for cloud-side vector search.
   */
  async embedQuery(query: string): Promise<number[]> {
    try {
      const emb = await this.getEmbedder();
      if (!emb) return [];
      const v = await emb.embed(query);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  async retrieve(query: string, limit = 8): Promise<RetrievalResult[]> {
    const intent = this.classifyQuery(query);

    const ftsResults = this.ftsSearch(query, limit);
    const semanticResults = await this.semanticSearch(query, limit);
    const graphResults = this.graphSearch(query, limit);

    return this.fuseResults(ftsResults, semanticResults, graphResults, intent, limit);
  }

  classifyQuery(query: string): QueryIntent {
    const lower = query.toLowerCase();

    // Architecture / flow queries → weight graph higher
    if (/trace|flow|impact|depends|breaks|removes?|calls?|imports?|architecture|relationship/.test(lower)) {
      return { ftsWeight: 0.2, semanticWeight: 0.2, graphWeight: 0.6 };
    }

    // Specific symbol lookups → weight FTS higher
    if (/where is|find|locate|file|function|class|interface|code/.test(lower)) {
      return { ftsWeight: 0.6, semanticWeight: 0.2, graphWeight: 0.2 };
    }

    // Conceptual / general questions → weight semantic/FTS higher
    return { ftsWeight: 0.4, semanticWeight: 0.4, graphWeight: 0.2 };
  }

  private ftsSearch(query: string, limit: number): RetrievalResult[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-zA-Z0-9_\-.]+/)
      .filter((t) => t.length > 2);

    if (terms.length === 0) return [];

    const clauses = terms.map(() => "content LIKE ?").join(" OR ");
    const params = terms.map((t) => `%${t}%`);
    const sql = `SELECT * FROM chunks WHERE ${clauses} LIMIT 50;`;

    try {
      const rows = this.storage.runQuery(sql, params);
      const results: RetrievalResult[] = [];
      for (const row of rows) {
        let score = 0;
        const contentLower = row.content.toLowerCase();
        for (const term of terms) {
          if (contentLower.includes(term)) {
            score += 1.0;
          }
        }
        score = score / (1.0 + Math.log(row.content.length) / 10.0);

        results.push({
          chunkId: row.id,
          nodeId: row.node_id,
          filePath: row.file_path,
          startLine: row.start_line,
          endLine: row.end_line,
          content: row.content,
          score,
          source: "fts",
        });
        this.enrichFreshness(results[results.length - 1], row.created_at, row.updated_at);
      }
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch {
      return [];
    }
  }

  async semanticSearch(query: string, limit: number): Promise<RetrievalResult[]> {
    try {
      const emb = await this.getEmbedder();
      if (!emb) return [];

      const queryVector = await emb.embed(query);
      const rows = this.storage.runQuery(`
        SELECT e.chunk_id, e.vector, c.content, c.file_path, c.start_line, c.end_line, c.created_at, c.updated_at
        FROM embeddings e
        JOIN chunks c ON e.chunk_id = c.id;
      `);

      if (rows.length === 0) return [];

      const matches: RetrievalResult[] = [];
      const queryLength = Math.sqrt(queryVector.reduce((sum: number, val: number) => sum + val * val, 0));

      for (const row of rows) {
        // SQL.js exports BLOBs as Uint8Array. Map back to float32
        const floatArray = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);

        let dotProduct = 0;
        let vecLengthSum = 0;
        for (let i = 0; i < queryVector.length; i++) {
          dotProduct += queryVector[i] * floatArray[i];
          vecLengthSum += floatArray[i] * floatArray[i];
        }
        const vecLength = Math.sqrt(vecLengthSum);
        const sim = queryLength > 0 && vecLength > 0 ? dotProduct / (queryLength * vecLength) : 0;

        if (sim > 0.25) {
          const match: RetrievalResult = {
            chunkId: row.chunk_id,
            filePath: row.file_path,
            startLine: row.start_line,
            endLine: row.end_line,
            content: row.content,
            score: sim,
            source: "semantic",
          };
          this.enrichFreshness(match, row.created_at, row.updated_at);
          matches.push(match);
        }
      }

      return matches.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch {
      return [];
    }
  }

  private graphSearch(query: string, limit: number): RetrievalResult[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-zA-Z0-9_\-.]+/)
      .filter((t) => t.length > 2);

    if (terms.length === 0) return [];

    const matchedNodes: any[] = [];
    for (const term of terms) {
      try {
        const sql = "SELECT * FROM nodes WHERE label LIKE ? OR id LIKE ? LIMIT 10;";
        const rows = this.storage.runQuery(sql, [`%${term}%`, `%${term}%`]);
        matchedNodes.push(...rows);
      } catch {
        // ignore
      }
    }

    const nodeMap = new Map<string, any>();
    for (const node of matchedNodes) {
      nodeMap.set(node.id, node);
    }

    const results: RetrievalResult[] = [];
    const visited = new Set<string>();

    for (const node of nodeMap.values()) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);

      if (node.content) {
        const r: RetrievalResult = {
          nodeId: node.id,
          filePath: node.source_file || "",
          content: node.content,
          score: 1.0,
          source: "graph",
        };
        this.enrichFreshness(r, node.created_at, node.updated_at);
        results.push(r);
      }

      try {
        const neighbors = this.storage.getNeighbors(node.id);
        for (const neighbor of neighbors) {
          if (visited.has(neighbor.node.id)) continue;
          visited.add(neighbor.node.id);

          if (neighbor.node.content) {
            const r: RetrievalResult = {
              nodeId: neighbor.node.id,
              filePath: neighbor.node.sourceFile || "",
              content: neighbor.node.content,
              score: 0.7,
              source: "graph",
            };
            this.enrichFreshness(r, neighbor.node.createdAt, neighbor.node.updatedAt);
            results.push(r);
          }
        }
      } catch {
        // ignore neighbor query errors
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private fuseResults(
    fts: RetrievalResult[],
    semantic: RetrievalResult[],
    graph: RetrievalResult[],
    weights: QueryIntent,
    limit: number,
  ): RetrievalResult[] {
    const fusedMap = new Map<string, RetrievalResult>();

    const merge = (results: RetrievalResult[], weight: number) => {
      if (results.length === 0) return;
      const maxScore = Math.max(...results.map((r) => r.score)) || 1.0;

      for (const r of results) {
        const key = r.chunkId || r.nodeId || `${r.filePath}:${r.startLine}-${r.endLine}`;
        const recency = this.recencyBoost(r.lastVerifiedAt ?? r.createdAt);
        const boostedScore = (r.score / maxScore) * weight * recency;

        const existing = fusedMap.get(key);
        if (existing) {
          existing.score += boostedScore;
          if (boostedScore > existing.score - boostedScore) {
            existing.source = r.source;
          }
        } else {
          fusedMap.set(key, {
            ...r,
            score: boostedScore,
          });
        }
      }
    };

    merge(fts, weights.ftsWeight);
    merge(semantic, weights.semanticWeight);
    merge(graph, weights.graphWeight);

    return Array.from(fusedMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  buildContext(_query: string, results: RetrievalResult[]): string {
    if (results.length === 0) return "";

    let context = "═══ Workspace Context ═══\n\n";
    let tokenEstimate = 0;
    const maxChars = 6000;

    for (const r of results) {
      let block = "";
      if (r.startLine && r.endLine) {
        block = `[File: ${r.filePath}] (lines ${r.startLine}-${r.endLine})\n`;
      } else {
        block = `[File/Entity: ${r.filePath || r.nodeId}]\n`;
      }
      block += `${r.content}\n\n`;

      if (tokenEstimate + block.length > maxChars) {
        break;
      }
      context += block;
      tokenEstimate += block.length;
    }

    context += "═════════════════════════";
    return context;
  }
}
