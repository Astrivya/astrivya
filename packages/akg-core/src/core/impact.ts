import type { AkgStorage } from "../akg-storage";
import type { AkgNode } from "../akg-types";
import { GraphTraversal } from "./traversal";

export interface ImpactReport {
  targetNode: AkgNode;
  directlyAffected: AkgNode[];
  transitivelyAffected: AkgNode[];
  riskScore: number;
  summary: string;
}

export class ImpactAnalyzer {
  private traversal: GraphTraversal;

  constructor(private storage: AkgStorage) {
    this.traversal = new GraphTraversal(storage);
  }

  analyzeRemoval(nodeId: string): ImpactReport | null {
    const node = this.storage.getNode(nodeId);
    if (!node) return null;

    const direct = this.traversal.dependents(nodeId, false);
    const transitiveAll = this.traversal.dependents(nodeId, true);

    const directIds = new Set(direct.map((d) => d.id));
    const transitiveOnly = transitiveAll.filter((t) => !directIds.has(t.id));

    const totalAffected = transitiveAll.length;
    let riskScore = 0.0;

    if (totalAffected > 0) {
      riskScore = Math.min(1.0, 0.15 + Math.log10(totalAffected) * 0.4);
    }

    let summary = `Removing "${node.label}" has a low impact with no dependent code nodes affected.`;
    if (totalAffected > 8) {
      summary = `Removing "${node.label}" has a HIGH impact, affecting ${totalAffected} nodes transitively.`;
    } else if (totalAffected > 0) {
      summary = `Removing "${node.label}" has a MODERATE impact, affecting ${totalAffected} nodes directly/transitively.`;
    }

    return {
      targetNode: node,
      directlyAffected: direct,
      transitivelyAffected: transitiveOnly,
      riskScore,
      summary,
    };
  }

  criticalityRanking(limit = 10): { node: AkgNode; score: number }[] {
    const sql = `
      SELECT target as id, COUNT(*) as cnt FROM edges
      GROUP BY target
      ORDER BY cnt DESC
      LIMIT ?;
    `;
    try {
      const rows = this.storage.runQuery(sql, [limit]);
      const results = [];
      for (const r of rows) {
        const node = this.storage.getNode(r.id);
        if (node) {
          results.push({
            node,
            score: r.cnt,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  findCycles(maxLength = 5): { path: string[] }[] {
    // DFS cycle detection for short circular dependencies
    const adj = new Map<string, string[]>();
    const nodes = this.storage.runQuery("SELECT id FROM nodes;");
    const edges = this.storage.runQuery("SELECT source, target FROM edges;");

    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source)!.push(e.target);
    }

    const cycles: { path: string[] }[] = [];
    const visited = new Set<string>();

    const dfs = (curr: string, path: string[]) => {
      if (path.length > maxLength) return;

      const cycleStartIdx = path.indexOf(curr);
      if (cycleStartIdx !== -1) {
        // Cycle detected
        const cyclePath = path.slice(cycleStartIdx);
        // Canonical format
        const minVal = [...cyclePath].sort()[0];
        const minIdx = cyclePath.indexOf(minVal);
        const canonical = [...cyclePath.slice(minIdx), ...cyclePath.slice(0, minIdx)];
        const key = canonical.join("->");

        if (!visited.has(key)) {
          visited.add(key);
          cycles.push({ path: canonical });
        }
        return;
      }

      const neighbors = adj.get(curr) || [];
      for (const n of neighbors) {
        dfs(n, [...path, curr]);
      }
    };

    for (const node of nodes) {
      dfs(node.id, []);
    }

    return cycles;
  }
}
