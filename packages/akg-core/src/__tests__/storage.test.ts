import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AkgStorage } from "../index";
import { cleanupTempWorkspace, createTempWorkspace } from "./helpers";

describe("AkgStorage e2e", () => {
  let dir: string;
  let storage: AkgStorage;

  beforeAll(async () => {
    dir = createTempWorkspace();
    storage = new AkgStorage();
    await storage.init(dir);
  });

  afterAll(() => {
    cleanupTempWorkspace(dir);
  });

  it("creates database file on disk", () => {
    const dbPath = path.join(dir, ".astrivya", "akg.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBeGreaterThan(0);
  });

  it("inserts a node and reads it back", () => {
    storage.upsertNode({
      id: "test:n1",
      label: "Node One",
      type: "document",
      createdAt: 1000,
      updatedAt: 1000,
    });
    const node = storage.getNode("test:n1");
    expect(node).not.toBeNull();
    expect(node!.id).toBe("test:n1");
    expect(node!.label).toBe("Node One");
    expect(node!.type).toBe("document");
  });

  it("updates an existing node", () => {
    storage.upsertNode({
      id: "test:n1",
      label: "Node One Updated",
      type: "document",
      content: "new content",
      createdAt: 1000,
      updatedAt: 2000,
    });
    const node = storage.getNode("test:n1");
    expect(node!.label).toBe("Node One Updated");
    expect(node!.content).toBe("new content");
    expect(node!.updatedAt).toBe(2000);
  });

  it("inserts multiple nodes of different types", () => {
    storage.upsertNode({
      id: "file:src/main.ts",
      label: "main.ts",
      type: "file",
      sourceFile: "src/main.ts",
      createdAt: 1000,
      updatedAt: 1000,
    });
    storage.upsertNode({
      id: "adr:use-rest",
      label: "Use REST API",
      type: "adr",
      content: "Decision to use REST over GraphQL",
      createdAt: 1000,
      updatedAt: 1000,
    });
    storage.upsertNode({
      id: "person:alice",
      label: "Alice",
      type: "person",
      createdAt: 1000,
      updatedAt: 1000,
    });

    expect(storage.getNode("file:src/main.ts")!.type).toBe("file");
    expect(storage.getNode("adr:use-rest")!.type).toBe("adr");
    expect(storage.getNode("person:alice")!.type).toBe("person");
  });

  it("returns null for missing node", () => {
    expect(storage.getNode("nonexistent")).toBeNull();
  });

  it("handles edges between nodes", () => {
    storage.addEdge({ source: "file:src/main.ts", target: "adr:use-rest", relation: "documents" });
    const neighbors = storage.getNeighbors("file:src/main.ts");
    expect(neighbors.length).toBe(1);
    expect(neighbors[0].direction).toBe("out");
    expect(neighbors[0].node.id).toBe("adr:use-rest");
    expect(neighbors[0].relation).toBe("documents");
  });

  it("addEdge auto-creates stub nodes for missing endpoints", () => {
    storage.addEdge({ source: "file:a.ts", target: "file:b.ts", relation: "imports" });
    expect(storage.getNode("file:a.ts")).not.toBeNull();
    expect(storage.getNode("file:b.ts")).not.toBeNull();
  });

  it("returns bidirectional neighbors", () => {
    const inbound = storage.getNeighbors("adr:use-rest");
    const hasIn = inbound.some((n) => n.direction === "in" && n.node.id === "file:src/main.ts");
    expect(hasIn).toBe(true);
  });

  it("deletes a node via raw SQL", () => {
    storage.run("DELETE FROM nodes WHERE id = ?", ["person:alice"]);
    expect(storage.getNode("person:alice")).toBeNull();
  });

  it("cascades edge deletion when source node is deleted", () => {
    storage.run("PRAGMA foreign_keys = ON");
    storage.run("DELETE FROM nodes WHERE id = ?", ["file:src/main.ts"]);
    // Edge from file:src/main.ts should cascade
    const neighbors = storage.getNeighbors("adr:use-rest");
    const hasEdge = neighbors.some((n) => n.node.id === "file:src/main.ts");
    expect(hasEdge).toBe(false);
  });

  it("inserts and retrieves chunks", () => {
    storage.upsertChunk({
      id: "chunk:1",
      nodeId: "file:a.ts",
      filePath: "file:a.ts",
      startLine: 1,
      endLine: 10,
      content: "function foo() { return 42; }",
      createdAt: 1000,
      updatedAt: 1000,
    });
    const rows = storage.runQuery("SELECT * FROM chunks WHERE id = ?", ["chunk:1"]);
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("function foo");
  });

  it("inserts and retrieves communities", () => {
    storage.upsertCommunity({ id: 1, label: "Core Module", nodeCount: 5, cohesion: 0.8 });
    const rows = storage.runQuery("SELECT * FROM communities WHERE id = ?", [1]);
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("Core Module");
  });

  it("returns correct stats", () => {
    const stats = storage.getStats();
    expect(stats.nodes).toBeGreaterThanOrEqual(4);
    // Cascade delete removed one edge, leaving at least 1
    expect(stats.edges).toBeGreaterThanOrEqual(1);
    expect(stats.chunks).toBeGreaterThanOrEqual(1);
    expect(stats.dbSize).toBeGreaterThan(0);
  });

  it("persists data across re-initialization", async () => {
    // upsertNode/addEdge modify in-memory DB — persist to disk first
    storage.saveToDisk();
    const storage2 = new AkgStorage();
    await storage2.init(dir);
    expect(storage2.getNode("file:b.ts")).not.toBeNull();
    expect(storage2.getNode("adr:use-rest")).not.toBeNull();
    expect(storage2.getNode("test:n1")!.label).toBe("Node One Updated");
    const stats = storage2.getStats();
    expect(stats.nodes).toBeGreaterThanOrEqual(4);
  });
});
