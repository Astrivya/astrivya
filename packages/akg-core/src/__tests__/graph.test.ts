import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AkgStorage, GraphTraversal, ImpactAnalyzer, mergeChunks, mergeEdges, mergeGraphs, mergeNode } from "../index";
import { cleanupTempWorkspace, createTempWorkspace } from "./helpers";

describe("GraphTraversal e2e", () => {
  let dir: string;
  let storage: AkgStorage;
  let traversal: GraphTraversal;

  beforeAll(async () => {
    dir = createTempWorkspace();
    storage = new AkgStorage();
    await storage.init(dir);

    // Chain: A → B → C
    // Diamond: D → E, D → F, E → G, F → G
    const nodes: Array<{
      id: string;
      label: string;
      type: "file";
      createdAt: number;
      updatedAt: number;
    }> = [
      { id: "A", label: "Alpha", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "B", label: "Beta", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "C", label: "Gamma", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "D", label: "Delta", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "E", label: "Epsilon", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "F", label: "Phi", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "G", label: "Gamma", type: "file", createdAt: 1, updatedAt: 1 },
    ];
    for (const n of nodes) storage.upsertNode(n);

    const edges: Array<{
      source: string;
      target: string;
      relation: "imports" | "depends_on";
    }> = [
      { source: "A", target: "B", relation: "imports" },
      { source: "B", target: "C", relation: "imports" },
      { source: "D", target: "E", relation: "depends_on" },
      { source: "D", target: "F", relation: "depends_on" },
      { source: "E", target: "G", relation: "depends_on" },
      { source: "F", target: "G", relation: "depends_on" },
    ];
    for (const e of edges) storage.addEdge(e);

    traversal = new GraphTraversal(storage);
  });

  afterAll(() => {
    cleanupTempWorkspace(dir);
  });

  it("shortestPath returns correct path for a chain", () => {
    const result = traversal.shortestPath("A", "C");
    expect(result).not.toBeNull();
    expect(result!.nodes.map((n) => n.id)).toEqual(["A", "B", "C"]);
    expect(result!.edges.length).toBe(2);
  });

  it("shortestPath returns null when there is no path", () => {
    expect(traversal.shortestPath("A", "Z")).toBeNull();
  });

  it("shortestPath returns null when toId does not exist in graph", () => {
    const result = traversal.shortestPath("A", "nonexistent");
    expect(result).toBeNull();
  });

  it("dependencies returns direct dependencies", () => {
    const deps = traversal.dependencies("A", false);
    expect(deps.length).toBe(1);
    expect(deps[0].id).toBe("B");
  });

  it("dependencies returns transitive dependencies", () => {
    const deps = traversal.dependencies("A", true);
    const ids = deps.map((d) => d.id);
    expect(ids).toContain("B");
    expect(ids).toContain("C");
  });

  it("dependents returns nodes that depend on a given node", () => {
    // G is depended on by E and F — D depends on E and F
    const deps = traversal.dependents("G", true);
    const ids = deps.map((d) => d.id).sort();
    expect(ids).toEqual(["D", "E", "F"]);
  });

  it("topologicalSort orders nodes by dependency depth", () => {
    const result = traversal.topologicalSort();
    // Edge A→B (imports): A depends on B → B must come before A
    // Edge B→C (imports): B depends on C → C must come before B
    // Edge D→E (depends_on): D depends on E → E before D
    // Edge D→F (depends_on): D depends on F → F before D
    // Edge E→G (depends_on): E depends on G → G before E
    // Edge F→G (depends_on): F depends on G → G before F
    const ids = result.entries.map((e) => e.node.id);
    const aIdx = ids.indexOf("A");
    const bIdx = ids.indexOf("B");
    const cIdx = ids.indexOf("C");
    expect(cIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(aIdx);
    const dIdx = ids.indexOf("D");
    const eIdx = ids.indexOf("E");
    const fIdx = ids.indexOf("F");
    const gIdx = ids.indexOf("G");
    expect(gIdx).toBeLessThan(eIdx);
    expect(gIdx).toBeLessThan(fIdx);
    expect(eIdx).toBeLessThan(dIdx);
    expect(fIdx).toBeLessThan(dIdx);
  });

  it("topologicalSort respects relation filter", () => {
    // Only edges with relation 'depends_on' are used for ordering
    // D→E, D→F, E→G, F→G. All other nodes (A,B,C) have inDegree 0.
    // G has inDegree 0, E/F have inDegree 1, D has inDegree 2.
    const result = traversal.topologicalSort(["depends_on"]);
    const ids = result.entries.map((e) => e.node.id);
    expect(ids).toContain("D");
    expect(ids).toContain("E");
    expect(ids).toContain("F");
    expect(ids).toContain("G");
    // G comes before E and F (E and F depend on G)
    const gIdx = ids.indexOf("G");
    expect(gIdx).toBeLessThan(ids.indexOf("E"));
    expect(gIdx).toBeLessThan(ids.indexOf("F"));
    // E and F come before D (D depends on E and F)
    expect(ids.indexOf("E")).toBeLessThan(ids.indexOf("D"));
    expect(ids.indexOf("F")).toBeLessThan(ids.indexOf("D"));
  });

  it("detects no cycles in a DAG", () => {
    const result = traversal.topologicalSort();
    expect(result.cycleNodeIds.length).toBe(0);
  });
});

describe("ImpactAnalyzer e2e", () => {
  let dir: string;
  let storage: AkgStorage;
  let analyzer: ImpactAnalyzer;

  beforeAll(async () => {
    dir = createTempWorkspace();
    storage = new AkgStorage();
    await storage.init(dir);

    const nodes: Array<{
      id: string;
      label: string;
      type: "file";
      createdAt: number;
      updatedAt: number;
    }> = [
      { id: "lib:utils", label: "utils.js", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "lib:db", label: "db.js", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "src:service", label: "service.js", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "src:controller", label: "controller.js", type: "file", createdAt: 1, updatedAt: 1 },
      { id: "src:server", label: "server.js", type: "file", createdAt: 1, updatedAt: 1 },
    ];
    for (const n of nodes) storage.upsertNode(n);

    const edges: Array<{
      source: string;
      target: string;
      relation: "imports";
    }> = [
      { source: "src:controller", target: "src:service", relation: "imports" },
      { source: "src:service", target: "lib:utils", relation: "imports" },
      { source: "src:service", target: "lib:db", relation: "imports" },
      { source: "src:server", target: "src:controller", relation: "imports" },
    ];
    for (const e of edges) storage.addEdge(e);

    analyzer = new ImpactAnalyzer(storage);
  });

  afterAll(() => {
    cleanupTempWorkspace(dir);
  });

  it("analyzeRemoval returns null for non-existent node", () => {
    expect(analyzer.analyzeRemoval("nonexistent")).toBeNull();
  });

  it("analyzeRemoval finds direct dependents", () => {
    const report = analyzer.analyzeRemoval("lib:utils");
    expect(report).not.toBeNull();
    expect(report!.targetNode.id).toBe("lib:utils");
    expect(report!.directlyAffected.length).toBe(1);
    expect(report!.directlyAffected[0].id).toBe("src:service");
  });

  it("analyzeRemoval finds transitive dependents", () => {
    const report = analyzer.analyzeRemoval("lib:utils");
    const transitiveIds = report!.transitivelyAffected.map((n) => n.id).sort();
    expect(transitiveIds).toContain("src:controller");
    expect(transitiveIds).toContain("src:server");
  });

  it("analyzeRemoval calculates riskScore based on impact count", () => {
    const report = analyzer.analyzeRemoval("lib:utils");
    // Removing utils affects 3 nodes transitively → moderate risk
    expect(report!.riskScore).toBeGreaterThan(0);
    expect(report!.riskScore).toBeLessThanOrEqual(1);
    expect(report!.summary).toContain("MODERATE");
  });

  it("analyzeRemoval on root node returns LOW impact", () => {
    const report = analyzer.analyzeRemoval("src:server");
    expect(report!.riskScore).toBeLessThan(0.5);
    expect(report!.summary).toContain("low impact");
  });

  it("analyzeRemoval on leaf node (no dependents) returns LOW impact", () => {
    // Add an isolated leaf node
    storage.upsertNode({ id: "lib:isolated", label: "isolated.js", type: "file", createdAt: 1, updatedAt: 1 });
    const report = analyzer.analyzeRemoval("lib:isolated");
    expect(report).not.toBeNull();
    expect(report!.directlyAffected.length).toBe(0);
    expect(report!.transitivelyAffected.length).toBe(0);
    expect(report!.riskScore).toBeLessThan(0.5);
  });
});

describe("Merge functions e2e", () => {
  it("mergeNode picks the newer version", () => {
    const older: Parameters<typeof mergeNode>[0] = {
      id: "x",
      label: "old",
      type: "file" as const,
      createdAt: 1,
      updatedAt: 10,
    };
    const newer: Parameters<typeof mergeNode>[1] = {
      id: "x",
      label: "new",
      type: "file" as const,
      createdAt: 2,
      updatedAt: 20,
    };
    const result = mergeNode(older, newer);
    expect(result.label).toBe("new");
    expect(result.createdAt).toBe(2);
  });

  it("mergeNode picks the node with higher id on equal timestamps", () => {
    const a: Parameters<typeof mergeNode>[0] = {
      id: "a",
      label: "a",
      type: "file" as const,
      createdAt: 1,
      updatedAt: 10,
    };
    const b: Parameters<typeof mergeNode>[1] = {
      id: "b",
      label: "b",
      type: "file" as const,
      createdAt: 1,
      updatedAt: 10,
    };
    expect(mergeNode(a, b).id).toBe("b");
  });

  it("mergeEdges deduplicates by source+target+relation, prefers higher weight", () => {
    const local = [
      { source: "A", target: "B", relation: "imports", weight: 0.5 },
      { source: "B", target: "C", relation: "imports", weight: 1.0 },
    ] as any[];
    const remote = [
      { source: "A", target: "B", relation: "imports", weight: 1.0 },
      { source: "C", target: "D", relation: "imports", weight: 1.0 },
    ] as any[];
    const merged = mergeEdges(local, remote);
    expect(merged.length).toBe(3);
    const ab = merged.find((e) => e.source === "A" && e.target === "B");
    expect(ab!.weight).toBe(1.0);
  });

  it("mergeChunks picks the newer version by updatedAt", () => {
    const local = [{ id: "c1", filePath: "f.ts", content: "old", createdAt: 1, updatedAt: 10 }] as any[];
    const remote = [{ id: "c1", filePath: "f.ts", content: "new", createdAt: 2, updatedAt: 20 }] as any[];
    const merged = mergeChunks(local, remote);
    expect(merged.length).toBe(1);
    expect(merged[0].content).toBe("new");
  });

  it("mergeGraphs combines nodes, edges, and chunks from both sources", () => {
    const local: any = {
      version: 1,
      schema: "akg-v1",
      workspaceId: "ws1",
      exportedAt: 100,
      nodes: [{ id: "A", label: "A", type: "file", createdAt: 1, updatedAt: 1 }],
      edges: [],
      chunks: [],
      communities: [],
    };
    const remote: any = {
      version: 1,
      schema: "akg-v1",
      workspaceId: "ws2",
      exportedAt: 200,
      nodes: [{ id: "B", label: "B", type: "file", createdAt: 2, updatedAt: 2 }],
      edges: [],
      chunks: [],
      communities: [],
    };
    const result = mergeGraphs(local, remote);
    const nodeIds = result.merged.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain("A");
    expect(nodeIds).toContain("B");
  });

  it("mergeGraphs normalizes cloud snake_case nodes so remote wins on newer updated_at", () => {
    const local: any = {
      version: 1,
      schema: "akg-v1",
      workspaceId: "ws1",
      exportedAt: 100,
      nodes: [{ id: "A", label: "A", type: "file", metadata: '{"x":1}', createdAt: 1000, updatedAt: 1000 }],
      edges: [],
      chunks: [],
      communities: [],
    };
    const remote: any = {
      version: 1,
      schema: "akg-v1",
      workspaceId: "ws2",
      exportedAt: 200,
      nodes: [
        {
          id: "A",
          label: "A (new)",
          type: "file",
          metadata: { x: 2 },
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      edges: [],
      chunks: [],
      communities: [],
    };
    const result = mergeGraphs(local, remote);
    expect(result.merged.nodes.length).toBe(1);
    const merged = result.merged.nodes[0];
    // ISO string parsed to epoch ms, newer than local 1000 -> remote wins
    expect(merged.label).toBe("A (new)");
    expect(merged.updatedAt).toBeGreaterThan(1000);
    // JSONB object metadata stringified, not "[object Object]"
    expect(merged.metadata).toBe('{"x":2}');
  });
});
