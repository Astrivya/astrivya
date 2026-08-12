import * as fs from "node:fs";
import * as path from "node:path";
import { type AkgStorage, RelationshipEngine, enumerateCommunities } from "@astrivya/akg-core";
import { AdrParser } from "./adr-parser";
import { AgentParser } from "./agent-parser";
import { CodeChunker } from "./code-chunker";
import { indexUnitsParallel } from "./parallel";
import { TodoParser } from "./todo-parser";
import type { IndexProgressEvent, IndexResult } from "./types";
import { scanWorkspace, summarizeUnits } from "./workspace-map";

export interface IndexWorkspaceOptions {
  /** Index units in parallel worker threads (default: auto - on for 2+ units outside CI). */
  parallel?: boolean;
}

export class AkgIndexer {
  private adrParser: AdrParser;
  private agentParser: AgentParser;
  private todoParser: TodoParser;
  private codeChunker: CodeChunker;

  constructor(
    private storage: AkgStorage,
    private workspacePath: string,
  ) {
    this.adrParser = new AdrParser(storage, workspacePath);
    this.agentParser = new AgentParser(storage);
    this.todoParser = new TodoParser(storage);
    this.codeChunker = new CodeChunker(storage, workspacePath);
  }

  indexAll(): void {
    this.agentParser.parseAgentActivity(this.workspacePath);
    this.todoParser.parseWorkspaceTodos(this.workspacePath);
  }

  /**
   * Index the workspace with a simple string progress callback
   * (backward-compatible; prefer {@link indexWorkspaceDetailed}).
   */
  async indexWorkspace(onProgress?: (msg: string) => void): Promise<{
    filesIndexed: number;
    nodesCreated: number;
    edgesCreated: number;
    indexed: number;
    failed: number;
    chunks: number;
  }> {
    const result = await this.indexWorkspaceDetailed((ev) => {
      if (!onProgress) return;
      if (ev.phase === "agent") onProgress("Indexing agent activity...");
      else if (ev.phase === "todos") onProgress("Indexing TODO files...");
      else if (ev.phase === "code" && ev.file) onProgress(`Indexing ${ev.file}`);
      else if (ev.phase === "adr" && ev.file) onProgress(`Indexing ADR: ${ev.file}`);
      else if (ev.phase === "save") onProgress("Saving database...");
      else if (ev.phase === "done") {
        onProgress(
          `Indexed ${ev.filesDone ?? 0} files, ${ev.chunks ?? 0} chunks (${ev.nodes ?? 0} nodes, ${ev.edges ?? 0} edges)`,
        );
      }
    });
    return {
      filesIndexed: result.filesIndexed,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      indexed: result.indexed,
      failed: result.failed,
      chunks: result.chunks,
    };
  }

  /**
   * Index the workspace and emit structured progress events.
   *
   * Pipeline: detect (workspace map) -> agent activity -> todos -> code
   * (per unit/repo, parallel workers when enabled) -> merge -> ADRs
   * (root + per unit) -> save -> done.
   */
  async indexWorkspaceDetailed(
    onEvent?: (ev: IndexProgressEvent) => void,
    opts: IndexWorkspaceOptions = {},
  ): Promise<IndexResult> {
    const t0 = Date.now();
    const emit = (ev: IndexProgressEvent): void => onEvent?.(ev);
    const statsBefore = this.storage.getStats();
    this.storage.setAutoSave(2000);

    const map = scanWorkspace(this.workspacePath);
    const summary = summarizeUnits(map.units);
    const parts: string[] = [];
    if (summary.repos > 0) parts.push(`${summary.repos} git repo${summary.repos === 1 ? "" : "s"}`);
    if (summary.workspaces > 0) parts.push(`${summary.workspaces} workspace${summary.workspaces === 1 ? "" : "s"}`);
    if (summary.folders > 0) parts.push(`${summary.folders} folder${summary.folders === 1 ? "" : "s"}`);
    if (summary.loose > 0) parts.push(`${summary.loose} loose file${summary.loose === 1 ? "" : "s"}`);
    emit({
      phase: "detect",
      message: `Detected ${parts.join(", ") || "no indexable units"} - ${map.totalFiles} files`,
      unitCount: map.units.length,
      filesTotal: map.totalFiles,
      elapsedMs: Date.now() - t0,
    });

    emit({ phase: "agent", message: "Indexing agent activity...", elapsedMs: Date.now() - t0 });
    this.agentParser.parseAgentActivity(this.workspacePath);

    emit({ phase: "todos", message: "Indexing TODO files...", elapsedMs: Date.now() - t0 });
    this.todoParser.parseWorkspaceTodos(this.workspacePath);

    const parallel =
      opts.parallel ?? (map.units.length >= 2 && !process.env.CI && process.env.ASTRIVYA_PARALLEL !== "off");

    let codeResult: {
      files: number;
      chunks: number;
      symbols: number;
      errors: number;
      workersUsed: number;
      perUnit: Array<{ name: string; files: number; chunks: number; symbols: number; errors: number }>;
    };
    if (parallel) {
      emit({
        phase: "code",
        message: "Starting parallel index workers...",
        unitCount: map.units.length,
        filesTotal: map.totalFiles,
        elapsedMs: Date.now() - t0,
      });
      codeResult = await indexUnitsParallel(this.storage, map.units, {
        workspacePath: this.workspacePath,
        onEvent,
      });
    } else {
      const serial = await this.codeChunker.indexUnits(map.units, { saveToDisk: false, onEvent });
      codeResult = { ...serial, workersUsed: 0 };
    }

    let adrFiles = 0;
    const adrDirs = new Set<string>([path.join(this.workspacePath, "docs", "adr")]);
    for (const unit of map.units) adrDirs.add(path.join(unit.path, "docs", "adr"));
    for (const adrDir of adrDirs) {
      let files: string[];
      try {
        files = fs.readdirSync(adrDir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const file of files) {
        emit({ phase: "adr", file, message: `Indexing ADR: ${file}`, elapsedMs: Date.now() - t0 });
        try {
          const filePath = path.join(adrDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          await this.adrParser.parseAndIndexADR(filePath, content);
          adrFiles++;
        } catch {
          // skip failed ADR
        }
      }
    }

    emit({
      phase: "relations",
      message: "Extracting code relationships, imports and communities...",
      elapsedMs: Date.now() - t0,
    });
    await this.indexRelations(t0, emit);

    emit({ phase: "save", message: "Saving database...", elapsedMs: Date.now() - t0 });
    this.storage.saveToDisk();

    const statsAfter = this.storage.getStats();
    const nodesCreated = statsAfter.nodes - statsBefore.nodes;
    const edgesCreated = statsAfter.edges - statsBefore.edges;
    const result: IndexResult = {
      filesIndexed: codeResult.files + adrFiles,
      nodesCreated,
      edgesCreated,
      indexed: codeResult.files + adrFiles,
      failed: codeResult.errors,
      chunks: codeResult.chunks,
      elapsedMs: Date.now() - t0,
      workersUsed: codeResult.workersUsed,
      units: codeResult.perUnit,
    };

    emit({
      phase: "done",
      message: `Indexed ${result.filesIndexed} files, ${result.chunks} chunks in ${(result.elapsedMs / 1000).toFixed(1)}s`,
      unitCount: map.units.length,
      filesDone: map.totalFiles,
      filesTotal: map.totalFiles,
      nodes: statsAfter.nodes,
      edges: statsAfter.edges,
      chunks: result.chunks,
      errors: result.failed,
      filesPerSec: map.totalFiles / Math.max(1, result.elapsedMs / 1000),
      elapsedMs: result.elapsedMs,
    });

    return result;
  }

  /** Index every eligible file in the workspace (full re-index). */
  async reindexAll(onProgress?: (msg: string) => void): Promise<{ files: number; chunks: number; symbols: number }> {
    return await this.codeChunker.indexWorkspace(onProgress);
  }

  /**
   * Post-chunking graph enrichment: AST relationships (calls/uses/extends/
   * implements), import edges, git authorship metrics, and a connected-
   * components community pass. Never throws — each file is best-effort so
   * indexing cannot be broken by analysis failures.
   */
  private async indexRelations(t0: number, emit: (ev: IndexProgressEvent) => void): Promise<void> {
    const engine = new RelationshipEngine(this.storage, this.workspacePath);
    const files = this.storage.runQuery(
      "SELECT id, source_file FROM nodes WHERE type = 'file' AND source_file IS NOT NULL;",
    ) as Array<{ id: string; source_file: string }>;

    const codeExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
    const noGitMetrics = process.env.ASTRIVYA_NO_GIT_METRICS === "1";

    let importsEdges = 0;
    for (const file of files) {
      const ext = path.extname(file.source_file).toLowerCase();
      if (!codeExts.has(ext)) continue;
      try {
        const absolutePath = path.join(this.workspacePath, file.source_file);
        const content = fs.readFileSync(absolutePath, "utf-8");
        await engine.analyzeCodeRelationships(file.source_file, file.id, content);
        importsEdges += await engine.analyzeImports(file.source_file, file.id, content);
        if (!noGitMetrics) {
          await engine.analyzeAuthorship(file.source_file, file.id);
        }
      } catch {
        // per-file best-effort
      }
    }

    const edgeRows = this.storage.runQuery("SELECT source, target FROM edges;") as Array<{
      source: string;
      target: string;
    }>;
    const nodeRows = this.storage.runQuery("SELECT id FROM nodes;") as Array<{ id: string }>;
    const components = enumerateCommunities(
      edgeRows,
      nodeRows.map((n) => n.id),
    );
    components.forEach((component, index) => {
      for (const nodeId of component.nodeIds) this.storage.setCommunity(nodeId, index);
      if (component.nodeIds.length >= 2) {
        const cohesion = component.internalEdges / Math.max(1, component.nodeIds.length - 1);
        this.storage.upsertCommunity({
          id: index,
          label: `Community ${index + 1}`,
          nodeCount: component.nodeIds.length,
          cohesion: Number(cohesion.toFixed(3)),
        });
      }
    });

    emit({
      phase: "relations",
      message: `Relations: ${files.length} files analyzed, ${importsEdges} imports edges, ${components.length} communities`,
      elapsedMs: Date.now() - t0,
    });
  }

  async indexFile(filePath: string): Promise<boolean> {
    if (!filePath.endsWith(".md")) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    const isAdrDir = filePath.includes(path.join("docs", "adr"));
    if (isAdrDir) {
      return await this.adrParser.parseAndIndexADR(filePath, content);
    }
    return false;
  }
}
