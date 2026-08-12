import type { SyncGraph } from "../akg-storage";
import type { AkgChunk, AkgEdge, AkgNode } from "../akg-types";

function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function toJsonString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a remote node (e.g. from a cloud pull, which sends snake_case
 * keys, ISO-8601 timestamps and JSONB metadata objects) into the local
 * camelCase + epoch-ms + JSON-string shape used by the engine.
 */
export function normalizeRemoteNode(raw: any): AkgNode {
  const node: AkgNode = {
    id: String(raw.id ?? raw.ID ?? ""),
    label: String(raw.label ?? raw.id ?? ""),
    type: (raw.type ?? "file") as AkgNode["type"],
    metadata: toJsonString(raw.metadata),
    createdAt: toEpochMs(raw.createdAt ?? raw.created_at),
    updatedAt: toEpochMs(raw.updatedAt ?? raw.updated_at),
  };
  if (raw.content != null) node.content = String(raw.content);
  if (raw.sourceFile != null) node.sourceFile = String(raw.sourceFile);
  if (raw.source_file != null) node.sourceFile = String(raw.source_file);
  if (raw.community != null) node.community = Number(raw.community);
  return node;
}

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
  const remoteNodes = (remote.nodes || []).map(normalizeRemoteNode);
  const localNodes = new Map<string, any>();
  for (const n of local.nodes) localNodes.set(n.id, n);

  const mergedNodes: any[] = [];
  const seenNodes = new Set<string>();
  let nodeConflicts = 0;

  for (const n of local.nodes) {
    mergedNodes.push(n);
    seenNodes.add(n.id);
  }

  for (const rn of remoteNodes) {
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
