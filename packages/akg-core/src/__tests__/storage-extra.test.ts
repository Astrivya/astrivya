import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs from "sql.js";
import { afterAll, describe, expect, it } from "vitest";
import { AkgStorage } from "../index";
import { cleanupTempWorkspace, createTempWorkspace } from "./helpers";

describe("AkgStorage extras", () => {
  let dir = "";
  afterAll(() => {
    if (dir) cleanupTempWorkspace(dir);
  });

  it("initMemory keeps everything in memory and never touches disk", async () => {
    dir = createTempWorkspace();
    const storage = new AkgStorage();
    await storage.initMemory();
    storage.upsertNode({ id: "mem:1", label: "In Memory", type: "document", createdAt: 1, updatedAt: 1 });
    expect(storage.getNode("mem:1")).not.toBeNull();
    const dbPath = path.join(dir, ".astrivya", "akg.db");
    expect(fs.existsSync(dbPath)).toBe(false);
    storage.close();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("exportBuffer/mergeDatabase round-trips nodes, edges and chunks", async () => {
    const a = new AkgStorage();
    await a.initMemory();
    a.upsertNode({ id: "f:a", label: "A", type: "file", sourceFile: "a.ts", createdAt: 1, updatedAt: 1 });
    a.upsertNode({ id: "f:b", label: "B", type: "file", sourceFile: "b.ts", createdAt: 1, updatedAt: 1 });
    a.addEdge({ source: "f:a", target: "f:b", relation: "imports" });
    a.upsertChunk({
      id: "c:1",
      nodeId: "f:a",
      filePath: "a.ts",
      startLine: 1,
      endLine: 5,
      content: "export const a = 1;",
      createdAt: 1,
      updatedAt: 1,
    });

    const b = new AkgStorage();
    await b.initMemory();
    const counts = await b.mergeDatabase(a.exportBuffer());
    expect(counts.nodes).toBe(2);
    expect(counts.edges).toBe(1);
    expect(counts.chunks).toBe(1);
    expect(b.getNode("f:a")).not.toBeNull();
    expect(b.getNeighbors("f:a").length).toBe(1);
    expect(b.runQuery("SELECT COUNT(*) AS c FROM chunks WHERE id = 'c:1'")[0].c).toBe(1);

    // Re-merging is idempotent (edges INSERT OR IGNORE)
    const counts2 = await b.mergeDatabase(a.exportBuffer());
    expect(counts2.nodes).toBe(2);
    expect(b.runQuery("SELECT COUNT(*) AS c FROM edges")[0].c).toBe(1);
    a.close();
    b.close();
  });

  it("setAutoSave(true) flushes dirty writes to disk automatically", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-autosave-"));
    try {
      const storage = new AkgStorage();
      await storage.init(tmp);
      storage.setAutoSave(true);
      storage.upsertNode({
        id: "auto:1",
        label: "Auto Saved",
        type: "document",
        content: "should persist without explicit saveToDisk",
        createdAt: 1,
        updatedAt: 1,
      });

      const reloaded = new AkgStorage();
      await reloaded.init(tmp);
      expect(reloaded.getNode("auto:1")!.content).toBe("should persist without explicit saveToDisk");
      reloaded.close();
      storage.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("getFileHashes returns content_hash for file nodes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-hashes-"));
    try {
      const storage = new AkgStorage();
      await storage.init(tmp);
      storage.upsertNode({
        id: "file:src/main.ts",
        label: "main.ts",
        type: "file",
        sourceFile: "src/main.ts",
        contentHash: "abc123",
        createdAt: 1,
        updatedAt: 1,
      });
      storage.upsertNode({ id: "file:src/other.ts", label: "other.ts", type: "file", createdAt: 1, updatedAt: 1 });
      storage.upsertNode({ id: "doc:note", label: "Note", type: "document", createdAt: 1, updatedAt: 1 });

      const hashes = storage.getFileHashes();
      expect(hashes.get("file:src/main.ts")).toBe("abc123");
      expect(hashes.has("file:src/other.ts")).toBe(false);
      expect(hashes.has("doc:note")).toBe(false);
      storage.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("migrates a v2 persons table to v3 (role + is_primary with defaults)", async () => {
    const dir = createTempWorkspace();
    try {
      const astrivyaDir = path.join(dir, ".astrivya");
      fs.mkdirSync(astrivyaDir, { recursive: true });

      // Hand-craft a v2 database: persons without role/is_primary, schema 2.
      const SQL = await initSqlJs();
      const db = new SQL.Database();
      db.run("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);");
      db.run("INSERT INTO metadata (key, value) VALUES ('schema_version', '2');");
      db.run("CREATE TABLE persons (id TEXT PRIMARY KEY, name TEXT, email TEXT);");
      db.run("INSERT INTO persons (id, name, email) VALUES ('person::alice', 'Alice', 'alice@example.com');");
      fs.writeFileSync(path.join(astrivyaDir, "akg.db"), Buffer.from(db.export()));
      db.close();

      const storage = new AkgStorage();
      await storage.init(dir);

      const alice = storage.listPersons().find((p) => p.id === "person::alice")!;
      expect(alice.role).toBe("contributor");
      expect(alice.isPrimary).toBe(false);

      storage.addPerson({ id: "person::bob", name: "Bob", role: "owner", isPrimary: true });
      const bob = storage.listPersons().find((p) => p.id === "person::bob")!;
      expect(bob.role).toBe("owner");
      expect(bob.isPrimary).toBe(true);

      const version = storage.runQuery("SELECT value FROM metadata WHERE key = 'schema_version';")[0].value;
      expect(version).toBe("3");
      storage.close();
    } finally {
      cleanupTempWorkspace(dir);
    }
  });
});
