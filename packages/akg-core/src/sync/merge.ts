import type { SyncGraph } from "../akg-storage";
import type { AkgChunk, AkgEdge, AkgNode } from "../akg-types";

export function mergeNode(local: AkgNode, remote: AkgNode): AkgNode {
  if (remote.updatedAt > local.updatedAt) return remote;
  if (remote.updatedAt < local.updatedAt) return local;
  return remote.id > local.id ? remote : local;
}

export function mergeEdges(local: AkgEdge[], remote: AkgEdge[]): AkgEdge[] {
  const map = new Map<string, AkgEdge>();
  for (const e of local) {
    map.set(`${e.source}:${e.target}:${e.relation}`, e);
  }
  for (const e of remote) {
    const key = `${e.source}:${e.target}:${e.relation}`;
    const existing = map.get(key);
    if (!existing || (e.weight || 1) > (existing.weight || 1)) {
      map.set(key, e);
    }
  }
  return Array.from(map.values());
}

export function mergeChunks(local: AkgChunk[], remote: AkgChunk[]): AkgChunk[] {
  const map = new Map<string, AkgChunk>();
  for (const c of local) map.set(c.id, c);
  for (const c of remote) {
    const existing = map.get(c.id);
    if (!existing || c.updatedAt > existing.updatedAt) {
      map.set(c.id, c);
    }
  }
  return Array.from(map.values());
}

export function mergeGraphs(
  local: SyncGraph,
  remote: SyncGraph,
): {
  merged: SyncGraph;
  nodeConflicts: number;
  edgeConflicts: number;
} {
  const localNodes = new Map<string, any>();
  for (const n of local.nodes) localNodes.set(n.id, n);

  const mergedNodes: any[] = [];
  const seenNodes = new Set<string>();
  let nodeConflicts = 0;

  for (const n of local.nodes) {
    mergedNodes.push(n);
    seenNodes.add(n.id);
  }

  for (const rn of remote.nodes) {
    if (seenNodes.has(rn.id)) {
      const ln = localNodes.get(rn.id);
      if (rn.updatedAt !== ln.updatedAt) {
        nodeConflicts++;
      }
      const merged = rn.updatedAt > ln.updatedAt ? rn : rn.updatedAt < ln.updatedAt ? ln : rn.id > ln.id ? rn : ln;
      const idx = mergedNodes.findIndex((n: any) => n.id === rn.id);
      if (idx !== -1) mergedNodes[idx] = merged;
    } else {
      mergedNodes.push(rn);
      seenNodes.add(rn.id);
    }
  }

  const mergedEdges = mergeEdges(local.edges, remote.edges);
  const edgeConflicts = mergedEdges.length - Math.max(local.edges.length, remote.edges.length);

  return {
    merged: {
      version: Math.max(local.version, remote.version),
      schema: "akg-v1",
      workspaceId: local.workspaceId,
      exportedAt: Date.now(),
      nodes: mergedNodes,
      edges: mergedEdges,
      chunks: mergeChunks(local.chunks, remote.chunks),
      communities: [
        ...local.communities,
        ...remote.communities.filter((rc: any) => !local.communities.some((lc: any) => lc.id === rc.id)),
      ],
    },
    nodeConflicts,
    edgeConflicts,
  };
}
