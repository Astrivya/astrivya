import * as fs from "node:fs";
import * as path from "node:path";
import initSqlJs from "sql.js";
import type { AkgChunk, AkgCommunity, AkgEdge, AkgNode } from "./akg-types";
import { getErrorMessage } from "./errors";

/**
 * Guess the node type for a node id that does not exist yet (auto-created
 * stub by {@link AkgStorage.addEdge}). Recognizes the id prefixes used by
 * the indexer so stubs get meaningful types instead of a blanket "file".
 */
function guessStubType(id: string): AkgNode["type"] {
  if (id.startsWith("dependency::")) return "dependency";
  if (id.startsWith("person::")) return "person";
  if (id.startsWith("workspace::")) return "workspace";
  if (id.startsWith("folder::")) return "folder";
  if (id.startsWith("class::")) return "class";
  if (id.startsWith("interface::")) return "interface";
  if (id.startsWith("function::")) return "function";
  if (id.startsWith("heading::")) return "document";
  if (id.startsWith("decision::")) return "adr";
  if (id.startsWith("memory::")) return "agent_action";
  if (id.startsWith("task::")) return "task";
  return "file";
}

/**
 * SQLite-backed local knowledge graph storage.
 *
 * Manages nodes, edges, chunks (with FTS5 full-text search), 384-dim
 * vector embeddings, communities, and persons. All data is stored in a
 * single `.astrivya/akg.db` file under the workspace path.
 */
export class AkgStorage {
  private db: any = null;
  private dbPath = "";
  private autoSaveMode: boolean | number = true;
  private dirty = false;
  private autoSaveTimer: NodeJS.Timeout | null = null;

  /**
   * Initialize (or open) the AKG database for the given workspace.
   * The database file is created at `<workspacePath>/.astrivya/akg.db`.
   * If the file already exists, it is loaded with any pending schema
   * migrations applied automatically.
   */
  async init(workspacePath: string): Promise<void> {
    const astrivyaDir = path.join(workspacePath, ".astrivya");
    if (!fs.existsSync(astrivyaDir)) {
      fs.mkdirSync(astrivyaDir, { recursive: true });
    }
    this.dbPath = path.join(astrivyaDir, "akg.db");

    const SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      try {
        const fileBuffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(fileBuffer);
        this.runMigrations();
      } catch (err: unknown) {
        console.warn(`Failed to load akg.db, creating new database: ${getErrorMessage(err)}`);
        this.db = new SQL.Database();
        this.createSchema();
        this.saveToDisk();
      }
    } else {
      this.db = new SQL.Database();
      this.createSchema();
      this.saveToDisk();
    }
  }

  private createSchema(): void {
    const schemaSql = `
      CREATE TABLE IF NOT EXISTS nodes (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        type          TEXT NOT NULL,
        source_file   TEXT,
        source_location TEXT,
        content       TEXT,
        content_hash  TEXT,
        community     INTEGER,
        churn_rate    REAL DEFAULT 0,
        last_modified INTEGER,
        contributor_count INTEGER DEFAULT 0,
        metadata      TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_source ON nodes(source_file);
      CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community);

      CREATE TABLE IF NOT EXISTS edges (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        source    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        relation  TEXT NOT NULL,
        weight    REAL DEFAULT 1.0,
        confidence REAL DEFAULT 1.0,
        extraction_method TEXT DEFAULT 'regex',
        metadata  TEXT,
        UNIQUE(source, target, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
      CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);

      CREATE TABLE IF NOT EXISTS chunks (
        id            TEXT PRIMARY KEY,
        node_id       TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        file_path     TEXT NOT NULL,
        start_line    INTEGER,
        end_line      INTEGER,
        content       TEXT NOT NULL,
        content_hash  TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(node_id);

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id    TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        vector      BLOB NOT NULL,
        dimension   INTEGER DEFAULT 384
      );

      CREATE TABLE IF NOT EXISTS communities (
        id          INTEGER PRIMARY KEY,
        label       TEXT,
        node_count  INTEGER,
        cohesion    REAL,
        metadata    TEXT
      );

      CREATE TABLE IF NOT EXISTS persons (
        id          TEXT PRIMARY KEY,
        name        TEXT,
        email       TEXT
      );

      CREATE TABLE IF NOT EXISTS adr_links (
        adr_node_id  TEXT,
        code_node_id TEXT,
        PRIMARY KEY(adr_node_id, code_node_id)
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `;

    this.db.run(schemaSql);
    this.db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '2');");
  }

  private runMigrations(): void {
    let version = 1;
    try {
      const rows = this.runQuery("SELECT value FROM metadata WHERE key = 'schema_version' LIMIT 1;");
      if (rows.length > 0) {
        version = Number.parseInt(rows[0].value, 10);
      }
    } catch {
      version = 1;
    }

    if (version < 2) {
      try {
        this.run("ALTER TABLE nodes ADD COLUMN churn_rate REAL DEFAULT 0;");
        this.run("ALTER TABLE nodes ADD COLUMN last_modified INTEGER;");
        this.run("ALTER TABLE nodes ADD COLUMN contributor_count INTEGER DEFAULT 0;");
        this.run("ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0;");
        this.run("ALTER TABLE edges ADD COLUMN extraction_method TEXT DEFAULT 'regex';");

        this.run(`
          CREATE TABLE IF NOT EXISTS persons (
            id    TEXT PRIMARY KEY,
            name  TEXT,
            email TEXT
          );
        `);

        this.run(`
          CREATE TABLE IF NOT EXISTS adr_links (
            adr_node_id   TEXT,
            code_node_id  TEXT,
            PRIMARY KEY(adr_node_id, code_node_id)
          );
        `);

        this.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '2');");
        this.saveToDisk();
      } catch (err: unknown) {
        console.warn(`Migration to version 2 failed: ${getErrorMessage(err)}`);
      }
    }
  }

  saveToDisk(): void {
    if (!this.db || !this.dbPath) return;
    this.dirty = false;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  /**
   * Control persistence behavior.
   * - `true`: save to disk on every mutation (default; heavy for big indexes).
   * - `false`: never auto-save; call {@link saveToDisk} (flush) explicitly.
   * - `number` (ms): debounced auto-save, at most one flush per interval.
   */
  setAutoSave(mode: boolean | number): void {
    this.autoSaveMode = mode;
    if (typeof mode === "number" && mode > 0 && !this.autoSaveTimer) {
      this.autoSaveTimer = setTimeout(() => this.flushAutoSave(), mode);
      this.autoSaveTimer.unref?.();
    }
  }

  private flushAutoSave(): void {
    this.autoSaveTimer = null;
    if (!this.dirty) return;
    const interval = typeof this.autoSaveMode === "number" ? this.autoSaveMode : 2000;
    if (this.dbPath && this.dirty) this.saveToDisk();
    if (typeof this.autoSaveMode === "number" && this.autoSaveMode > 0) {
      this.autoSaveTimer = setTimeout(() => this.flushAutoSave(), interval);
      this.autoSaveTimer.unref?.();
    }
  }

  private maybeSave(): void {
    if (!this.db || !this.dbPath) return;
    if (this.autoSaveMode === false) return;
    if (this.autoSaveMode === true) {
      this.saveToDisk();
      return;
    }
    this.dirty = true;
    if (!this.autoSaveTimer) {
      this.autoSaveTimer = setTimeout(() => this.flushAutoSave(), this.autoSaveMode);
      this.autoSaveTimer.unref?.();
    }
  }

  /**
   * Initialize a purely in-memory database (schema only, no disk path, no
   * auto-save). Used by indexer workers that export their result as a buffer.
   */
  async initMemory(): Promise<void> {
    const SQL = await initSqlJs();
    this.db = new SQL.Database();
    this.createSchema();
    this.dbPath = "";
    this.autoSaveMode = false;
  }

  /** Export the current database as a portable SQLite buffer. */
  exportBuffer(): Buffer {
    if (!this.db) throw new Error("Database not initialized");
    return Buffer.from(this.db.export());
  }

  /**
   * Merge another AKG database buffer into this one. Nodes/chunks use
   * INSERT OR REPLACE; edges/embeddings/communities/persons/adr-links use
   * INSERT OR IGNORE (existing rows win). Returns per-table copy counts.
   */
  async mergeDatabase(buffer: Buffer): Promise<{ nodes: number; edges: number; chunks: number }> {
    const SQL = await initSqlJs();
    const scratch = new SQL.Database(new Uint8Array(buffer));
    const counts = { nodes: 0, edges: 0, chunks: 0 };
    const copyTable = (table: string, conflict: "replace" | "ignore"): void => {
      const cols = this.runQuery(`PRAGMA table_info(${table});`).map((r: any) => r.name);
      if (cols.length === 0) return;
      const colList = cols.join(", ");
      const placeholders = cols.map(() => "?").join(", ");
      const stmt = scratch.prepare(`SELECT * FROM ${table};`);
      while (stmt.step()) {
        const row = stmt.get();
        const params = row.map((v: unknown) => (v instanceof Uint8Array ? Buffer.from(v) : v));
        this.run(
          `INSERT OR ${conflict === "replace" ? "REPLACE" : "IGNORE"} INTO ${table} (${colList}) VALUES (${placeholders});`,
          params,
        );
        if (table === "nodes") counts.nodes++;
        else if (table === "edges") counts.edges++;
        else if (table === "chunks") counts.chunks++;
      }
      stmt.free();
    };
    copyTable("nodes", "replace");
    copyTable("edges", "ignore");
    copyTable("chunks", "replace");
    copyTable("embeddings", "ignore");
    copyTable("communities", "ignore");
    copyTable("persons", "ignore");
    copyTable("adr_links", "ignore");
    scratch.close();
    this.maybeSave();
    return counts;
  }

  /** Map of `file::` node id -> content hash, used to skip unchanged files across processes. */
  getFileHashes(): Map<string, string> {
    const map = new Map<string, string>();
    const rows = this.runQuery("SELECT id, content_hash FROM nodes WHERE type = 'file' AND content_hash IS NOT NULL;");
    for (const row of rows) map.set(row.id, row.content_hash);
    return map;
  }

  /** Execute a raw SQL query against the AKG database. */
  runQuery(sql: string, params: any[] = []): any[] {
    if (!this.db) throw new Error("Database not initialized");
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  run(sql: string, params: any[] = []): void {
    if (!this.db) throw new Error("Database not initialized");
    this.db.run(sql, params);
  }

  /**
   * Insert or update a node. If a node with the same `id` exists,
   * its fields are overwritten; otherwise a new row is inserted.
   */
  upsertNode(node: AkgNode): void {
    const exists = this.runQuery("SELECT 1 FROM nodes WHERE id = ? LIMIT 1;", [node.id]).length > 0;
    if (exists) {
      const sql = `
        UPDATE nodes SET
          label = ?,
          type = ?,
          source_file = ?,
          source_location = ?,
          content = ?,
          content_hash = ?,
          community = ?,
          churn_rate = ?,
          last_modified = ?,
          contributor_count = ?,
          metadata = ?,
          updated_at = ?
        WHERE id = ?;
      `;
      this.run(sql, [
        node.label,
        node.type,
        node.sourceFile || null,
        node.sourceLocation || null,
        node.content || null,
        node.contentHash || null,
        node.community !== undefined ? node.community : null,
        node.churnRate !== undefined ? node.churnRate : 0,
        node.lastModified || null,
        node.contributorCount !== undefined ? node.contributorCount : 0,
        node.metadata || null,
        node.updatedAt,
        node.id,
      ]);
    } else {
      const sql = `
        INSERT INTO nodes (
          id, label, type, source_file, source_location, content, content_hash, community, churn_rate, last_modified, contributor_count, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;
      this.run(sql, [
        node.id,
        node.label,
        node.type,
        node.sourceFile || null,
        node.sourceLocation || null,
        node.content || null,
        node.contentHash || null,
        node.community !== undefined ? node.community : null,
        node.churnRate !== undefined ? node.churnRate : 0,
        node.lastModified || null,
        node.contributorCount !== undefined ? node.contributorCount : 0,
        node.metadata || null,
        node.createdAt,
        node.updatedAt,
      ]);
    }
    this.maybeSave();
  }

  /**
   * Insert an edge between two nodes. If either endpoint node does not
   * exist it is auto-created as a stub node.
   */
  addEdge(edge: AkgEdge): void {
    const getLabel = (id: string) => {
      const parts = id.split("::");
      const last = parts[parts.length - 1];
      const subParts = last.split("/");
      return subParts[subParts.length - 1];
    };

    const sourceExists = this.runQuery("SELECT 1 FROM nodes WHERE id = ? LIMIT 1;", [edge.source]).length > 0;
    if (!sourceExists) {
      this.upsertNode({
        id: edge.source,
        label: getLabel(edge.source),
        type: guessStubType(edge.source),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const targetExists = this.runQuery("SELECT 1 FROM nodes WHERE id = ? LIMIT 1;", [edge.target]).length > 0;
    if (!targetExists) {
      this.upsertNode({
        id: edge.target,
        label: getLabel(edge.target),
        type: guessStubType(edge.target),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const sql = `
      INSERT OR IGNORE INTO edges (
        source, target, relation, weight, confidence, extraction_method, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?);
    `;
    this.run(sql, [
      edge.source,
      edge.target,
      edge.relation,
      edge.weight !== undefined ? edge.weight : 1.0,
      edge.confidence !== undefined ? edge.confidence : 1.0,
      edge.extractionMethod || "regex",
      edge.metadata || null,
    ]);
    this.maybeSave();
  }

  /** Insert or replace a content chunk (FTS-indexed). */
  upsertChunk(chunk: AkgChunk): void {
    const sql = `
      INSERT OR REPLACE INTO chunks (
        id, node_id, file_path, start_line, end_line, content, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;
    this.run(sql, [
      chunk.id,
      chunk.nodeId || null,
      chunk.filePath,
      chunk.startLine !== undefined ? chunk.startLine : null,
      chunk.endLine !== undefined ? chunk.endLine : null,
      chunk.content,
      chunk.contentHash || null,
      chunk.createdAt,
      chunk.updatedAt,
    ]);
    this.maybeSave();
  }

  /** Set the community id on a node (used by the indexer's CC pass). */
  setCommunity(nodeId: string, community: number): void {
    this.run("UPDATE nodes SET community = ? WHERE id = ?;", [community, nodeId]);
  }

  upsertCommunity(community: AkgCommunity): void {    const sql = `
      INSERT OR REPLACE INTO communities (
        id, label, node_count, cohesion, metadata
      ) VALUES (?, ?, ?, ?, ?);
    `;
    this.run(sql, [
      community.id,
      community.label || null,
      community.nodeCount !== undefined ? community.nodeCount : null,
      community.cohesion !== undefined ? community.cohesion : null,
      community.metadata || null,
    ]);
    this.maybeSave();
  }

  addPerson(person: { id: string; name?: string; email?: string }): void {
    const sql = `
      INSERT OR REPLACE INTO persons (id, name, email) VALUES (?, ?, ?);
    `;
    this.run(sql, [person.id, person.name || person.id.replace("person::", ""), person.email || null]);
    this.maybeSave();
  }

  addAdrLink(adrNodeId: string, codeNodeId: string): void {
    const sql = `
      INSERT OR REPLACE INTO adr_links (adr_node_id, code_node_id) VALUES (?, ?);
    `;
    this.run(sql, [adrNodeId, codeNodeId]);
    this.maybeSave();
  }

  getAdrLinks(adrNodeId: string): string[] {
    const rows = this.runQuery("SELECT code_node_id FROM adr_links WHERE adr_node_id = ?;", [adrNodeId]);
    return rows.map((r) => r.code_node_id);
  }

  deleteFileNodes(filePath: string): void {
    this.run("PRAGMA foreign_keys = ON;");
    const nodes = this.runQuery("SELECT id FROM nodes WHERE source_file = ?;", [filePath]);
    for (const node of nodes) {
      this.run("DELETE FROM nodes WHERE id = ?;", [node.id]);
    }
    this.run("DELETE FROM chunks WHERE file_path = ?;", [filePath]);
    this.maybeSave();
  }

  /** Look up a single node by its ID. Returns null if not found. */
  getNode(id: string): AkgNode | null {
    const results = this.runQuery("SELECT * FROM nodes WHERE id = ? LIMIT 1;", [id]);
    if (results.length === 0) return null;
    const r = results[0];
    return {
      id: r.id,
      label: r.label,
      type: r.type,
      sourceFile: r.source_file,
      sourceLocation: r.source_location,
      content: r.content,
      contentHash: r.content_hash,
      community: r.community,
      churnRate: r.churn_rate,
      lastModified: r.last_modified,
      contributorCount: r.contributor_count,
      metadata: r.metadata,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Get all immediate neighbor nodes and their edge relations. */
  getNeighbors(id: string): { node: AkgNode; relation: string; direction: "in" | "out" }[] {
    const neighbors: { node: AkgNode; relation: string; direction: "in" | "out" }[] = [];

    const outEdges = this.runQuery(
      `SELECT e.relation, n.* FROM edges e
       JOIN nodes n ON e.target = n.id
       WHERE e.source = ?;`,
      [id],
    );
    for (const r of outEdges) {
      neighbors.push({
        relation: r.relation,
        direction: "out",
        node: {
          id: r.id,
          label: r.label,
          type: r.type,
          sourceFile: r.source_file,
          sourceLocation: r.source_location,
          content: r.content,
          contentHash: r.content_hash,
          community: r.community,
          churnRate: r.churn_rate,
          lastModified: r.last_modified,
          contributorCount: r.contributor_count,
          metadata: r.metadata,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        },
      });
    }

    const inEdges = this.runQuery(
      `SELECT e.relation, n.* FROM edges e
       JOIN nodes n ON e.source = n.id
       WHERE e.target = ?;`,
      [id],
    );
    for (const r of inEdges) {
      neighbors.push({
        relation: r.relation,
        direction: "in",
        node: {
          id: r.id,
          label: r.label,
          type: r.type,
          sourceFile: r.source_file,
          sourceLocation: r.source_location,
          content: r.content,
          contentHash: r.content_hash,
          community: r.community,
          churnRate: r.churn_rate,
          lastModified: r.last_modified,
          contributorCount: r.contributor_count,
          metadata: r.metadata,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        },
      });
    }

    return neighbors;
  }

  /** Get aggregate statistics about the graph database. */
  getStats(): {
    nodes: number;
    edges: number;
    chunks: number;
    embeddings: number;
    communities: number;
    dbSize: number;
  } {
    const nodesCount = this.runQuery("SELECT COUNT(*) as cnt FROM nodes;")[0].cnt;
    const edgesCount = this.runQuery("SELECT COUNT(*) as cnt FROM edges;")[0].cnt;
    const chunksCount = this.runQuery("SELECT COUNT(*) as cnt FROM chunks;")[0].cnt;
    const embeddingsCount = this.runQuery("SELECT COUNT(*) as cnt FROM embeddings;")[0].cnt;
    const communitiesCount = this.runQuery("SELECT COUNT(*) as cnt FROM communities;")[0].cnt;

    let dbSize = 0;
    if (this.dbPath && fs.existsSync(this.dbPath)) {
      dbSize = fs.statSync(this.dbPath).size;
    }

    return {
      nodes: nodesCount,
      edges: edgesCount,
      chunks: chunksCount,
      embeddings: embeddingsCount,
      communities: communitiesCount,
      dbSize,
    };
  }

  exportGraph(): SyncGraph {
    const nodes = this.runQuery("SELECT * FROM nodes;");
    const edges = this.runQuery("SELECT * FROM edges;");
    const chunks = this.runQuery("SELECT * FROM chunks;");
    const communities = this.runQuery("SELECT * FROM communities;");

    const mapRow = (row: any): any => {
      const obj: any = {};
      for (const key of Object.keys(row)) {
        const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        obj[camelKey] = row[key];
      }
      return obj;
    };

    return {
      version: 1,
      schema: "akg-v1",
      workspaceId: this.dbPath,
      exportedAt: Date.now(),
      nodes: nodes.map(mapRow),
      edges: edges.map(mapRow),
      chunks: chunks.map(mapRow),
      communities: communities.map(mapRow),
    };
  }

  importGraph(data: SyncGraph): { merged: number; conflicts: number } {
    let merged = 0;
    let conflicts = 0;

    if (data.nodes) {
      for (const node of data.nodes) {
        try {
          const normalized = {
            ...node,
            metadata:
              node.metadata != null && typeof node.metadata !== "string"
                ? JSON.stringify(node.metadata)
                : node.metadata,
            createdAt: typeof node.createdAt === "string" ? Date.parse(node.createdAt) : node.createdAt,
            updatedAt: typeof node.updatedAt === "string" ? Date.parse(node.updatedAt) : node.updatedAt,
          };
          this.upsertNode(normalized);
          merged++;
        } catch {
          conflicts++;
        }
      }
    }

    if (data.edges) {
      for (const edge of data.edges) {
        try {
          this.addEdge(edge);
          merged++;
        } catch {
          conflicts++;
        }
      }
    }

    if (data.chunks) {
      for (const chunk of data.chunks) {
        try {
          this.upsertChunk(chunk);
          merged++;
        } catch {
          conflicts++;
        }
      }
    }

    if (data.communities) {
      for (const community of data.communities) {
        try {
          this.upsertCommunity(community);
          merged++;
        } catch {
          conflicts++;
        }
      }
    }

    this.saveToDisk();
    return { merged, conflicts };
  }

  close(): void {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.dirty) this.saveToDisk();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export interface SyncGraph {
  version: number;
  schema: string;
  workspaceId: string;
  exportedAt: number;
  nodes: any[];
  edges: any[];
  chunks: any[];
  communities: any[];
}
