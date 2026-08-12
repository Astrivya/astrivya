import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AkgStorage, RelationshipEngine, computeCommunities } from "@astrivya/akg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("RelationshipEngine + communities", () => {
  let dir: string;
  let storage: AkgStorage;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "akg-relations-"));
    storage = new AkgStorage();
    await storage.init(dir);
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedFile(rel: string, content: string): string {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const now = Date.now();
    const id = `file::${rel}`;
    storage.upsertNode({
      id,
      label: path.basename(rel),
      type: "file",
      sourceFile: rel,
      createdAt: now,
      updatedAt: now,
    });
    storage.upsertNode({
      id: `symbol::${rel}:aa`,
      label: "hello",
      type: "function",
      sourceFile: rel,
      content: "export function hello() {}",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  it("creates imports edges between file nodes for relative specifiers", async () => {
    const aId = seedFile("a.ts", 'import { hello } from "./b";\nhello();\n');
    seedFile("b.ts", "export function hello() { return 1; }\n");

    const engine = new RelationshipEngine(storage, dir);
    const edges = await engine.analyzeImports("a.ts", aId, 'import { hello } from "./b";');

    expect(edges).toBe(1);
    const rows = storage.runQuery("SELECT source, target, relation FROM edges WHERE relation = 'imports';");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("file::a.ts");
    expect(rows[0].target).toBe("file::b.ts");
  });

  it("does not create imports edges for unknown files", async () => {
    const aId = seedFile("a.ts", 'import x from "./missing";');
    const engine = new RelationshipEngine(storage, dir);
    const edges = await engine.analyzeImports("a.ts", aId, 'import x from "./missing";');
    expect(edges).toBe(0);
  });

  it("resolves extends to real class symbol nodes, not stubs", async () => {
    const now = Date.now();
    const fileId = "file::a.ts";
    fs.writeFileSync(path.join(dir, "a.ts"), "class Base {}\nclass Child extends Base {}\n");
    storage.upsertNode({
      id: fileId,
      label: "a.ts",
      type: "file",
      sourceFile: "a.ts",
      createdAt: now,
      updatedAt: now,
    });
    storage.upsertNode({
      id: "symbol::a.ts:base",
      label: "Base",
      type: "class",
      sourceFile: "a.ts",
      content: "class Base {}",
      createdAt: now,
      updatedAt: now,
    });
    storage.upsertNode({
      id: "symbol::a.ts:child",
      label: "Child",
      type: "class",
      sourceFile: "a.ts",
      content: "class Child extends Base {}",
      createdAt: now,
      updatedAt: now,
    });

    const engine = new RelationshipEngine(storage, dir);
    await engine.analyzeCodeRelationships("a.ts", fileId, "class Base {}\nclass Child extends Base {}\n");

    const rows = storage.runQuery("SELECT source, target, relation FROM edges WHERE relation = 'extends';");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("symbol::a.ts:child");
    expect(rows[0].target).toBe("symbol::a.ts:base");
    // no phantom stub nodes for class:: prefixed ids
    const stubs = storage.runQuery("SELECT id FROM nodes WHERE id LIKE 'class::%';");
    expect(stubs).toHaveLength(0);
  });

  it("computeCommunities assigns shared community ids to connected files", () => {
    seedFile("a.ts", "// a");
    seedFile("b.ts", "// b");
    const now = Date.now();
    storage.addEdge({ source: "file::a.ts", target: "file::b.ts", relation: "imports", weight: 1 });

    const edges = storage.runQuery("SELECT source, target FROM edges;");
    const nodes = storage.runQuery("SELECT id FROM nodes;");
    const assignment = computeCommunities(
      edges,
      nodes.map((n) => n.id),
    );
    expect(assignment.get("file::a.ts")).toBe(assignment.get("file::b.ts"));
    expect(assignment.get("file::a.ts")).toBeDefined();
  });
});
