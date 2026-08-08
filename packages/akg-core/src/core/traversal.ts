import type { AkgStorage } from "../akg-storage";
import type { AkgEdge, AkgNode, NodeType, RelationType } from "../akg-types";

export interface PathResult {
  nodes: AkgNode[];
  edges: AkgEdge[];
  totalWeight: number;
}

export interface TopoSortEntry {
  node: AkgNode;
  depth: number;
}

export interface TopoSortResult {
  entries: TopoSortEntry[];
  cycleNodeIds: string[];
}

export class GraphTraversal {
  private adjacencyList = new Map<string, { target: string; relation: string; weight: number }[]>();
  private nodesMap = new Map<string, AkgNode>();

  constructor(private storage: AkgStorage) {
    this.loadGraph();
  }

  private loadGraph(): void {
    const nodes = this.storage.runQuery("SELECT * FROM nodes;");
    for (const r of nodes) {
      this.nodesMap.set(r.id, {
        id: r.id,
        label: r.label,
        type: r.type,
        sourceFile: r.source_file,
        sourceLocation: r.source_location,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }

    const edges = this.storage.runQuery("SELECT * FROM edges;");
    for (const e of edges) {
      if (!this.adjacencyList.has(e.source)) {
        this.adjacencyList.set(e.source, []);
      }
      this.adjacencyList.get(e.source)!.push({
        target: e.target,
        relation: e.relation,
        weight: e.weight !== undefined ? e.weight : 1.0,
      });
    }
  }

  shortestPath(fromId: string, toId: string): PathResult | null {
    const distances = new Map<string, number>();
    const previous = new Map<string, string | null>();
    const visited = new Set<string>();
    const queue: string[] = [];

    for (const nodeId of this.nodesMap.keys()) {
      distances.set(nodeId, Number.POSITIVE_INFINITY);
      previous.set(nodeId, null);
    }

    if (!this.nodesMap.has(fromId) || !this.nodesMap.has(toId)) {
      return null;
    }

    distances.set(fromId, 0);
    queue.push(fromId);

    while (queue.length > 0) {
      queue.sort((a, b) => distances.get(a)! - distances.get(b)!);
      const current = queue.shift()!;

      if (current === toId) break;
      if (distances.get(current) === Number.POSITIVE_INFINITY) break;

      visited.add(current);

      const neighbors = this.adjacencyList.get(current) || [];
      for (const edge of neighbors) {
        if (visited.has(edge.target)) continue;

        const alt = distances.get(current)! + edge.weight;
        if (alt < distances.get(edge.target)!) {
          distances.set(edge.target, alt);
          previous.set(edge.target, current);
          if (!queue.includes(edge.target)) {
            queue.push(edge.target);
          }
        }
      }
    }

    if (distances.get(toId) === Number.POSITIVE_INFINITY) return null;

    const pathNodes: AkgNode[] = [];
    const pathEdges: AkgEdge[] = [];
    let curr: string | null = toId;

    while (curr !== null) {
      const node = this.nodesMap.get(curr);
      if (node) pathNodes.unshift(node);

      const prev: string | null = curr ? (previous.get(curr) ?? null) : null;
      if (prev) {
        const edgeList = this.adjacencyList.get(prev) || [];
        const match = edgeList.find((e) => e.target === curr);
        if (match) {
          pathEdges.unshift({
            source: prev,
            target: curr,
            relation: match.relation as any,
            weight: match.weight,
          });
        }
      }
      curr = prev;
    }

    return {
      nodes: pathNodes,
      edges: pathEdges,
      totalWeight: distances.get(toId)!,
    };
  }

  dependencies(nodeId: string, transitive = false): AkgNode[] {
    const deps: AkgNode[] = [];
    const visited = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current !== nodeId) {
        const node = this.nodesMap.get(current);
        if (node) deps.push(node);
      }

      const neighbors = this.adjacencyList.get(current) || [];
      for (const edge of neighbors) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          if (transitive) {
            queue.push(edge.target);
          } else if (current === nodeId) {
            const node = this.nodesMap.get(edge.target);
            if (node) deps.push(node);
          }
        }
      }
    }
    return deps;
  }

  topologicalSort(relationFilter?: RelationType[], nodeTypeFilter?: NodeType[]): TopoSortResult {
    const relations = relationFilter ?? (["imports", "depends_on"] as RelationType[]);
    const relationSet = new Set(relations);

    // Only include nodes matching the type filter (or all types if none specified)
    const activeNodes = new Set<string>();
    for (const [nodeId, node] of this.nodesMap.entries()) {
      if (!nodeTypeFilter || nodeTypeFilter.includes(node.type as NodeType)) {
        activeNodes.add(nodeId);
      }
    }

    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const nodeId of activeNodes) {
      inDegree.set(nodeId, 0);
      adj.set(nodeId, []);
    }

    for (const [source, edges] of this.adjacencyList.entries()) {
      for (const edge of edges) {
        if (!relationSet.has(edge.relation as RelationType)) continue;
        if (!activeNodes.has(source) || !activeNodes.has(edge.target)) continue;
        // source depends on target → target must come before source
        adj.get(edge.target)?.push(source);
        inDegree.set(source, (inDegree.get(source) || 0) + 1);
      }
    }

    const queue: string[] = [];
    const depthMap = new Map<string, number>();

    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(nodeId);
        depthMap.set(nodeId, 0);
      }
    }

    const entries: TopoSortEntry[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.nodesMap.get(current);
      if (node) {
        entries.push({ node, depth: depthMap.get(current) ?? 0 });
      }

      for (const neighbor of adj.get(current) || []) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        depthMap.set(neighbor, Math.max(depthMap.get(neighbor) ?? 0, (depthMap.get(current) ?? 0) + 1));
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    const cycleNodeIds: string[] = [];
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree > 0) {
        cycleNodeIds.push(nodeId);
      }
    }

    return { entries, cycleNodeIds };
  }

  dependents(nodeId: string, transitive = false): AkgNode[] {
    const deps: AkgNode[] = [];
    const visited = new Set<string>();

    const reverseAdjacency = new Map<string, string[]>();
    for (const [source, list] of this.adjacencyList.entries()) {
      for (const edge of list) {
        if (!reverseAdjacency.has(edge.target)) {
          reverseAdjacency.set(edge.target, []);
        }
        reverseAdjacency.get(edge.target)!.push(source);
      }
    }

    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current !== nodeId) {
        const node = this.nodesMap.get(current);
        if (node) deps.push(node);
      }

      const neighbors = reverseAdjacency.get(current) || [];
      for (const src of neighbors) {
        if (!visited.has(src)) {
          visited.add(src);
          if (transitive) {
            queue.push(src);
          } else if (current === nodeId) {
            const node = this.nodesMap.get(src);
            if (node) deps.push(node);
          }
        }
      }
    }
    return deps;
  }
}
