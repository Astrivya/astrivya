export interface AkgNode {
  id: string;
  label: string;
  type: string;
  sourceFile?: string;
  sourceLocation?: string;
  content?: string;
  community?: number;
  churnRate?: number;
  lastModified?: number;
  contributorCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AkgEdge {
  source: string;
  target: string;
  relation: string;
  weight?: number;
  confidence?: number;
  extractionMethod?: string;
}

export interface GraphData {
  nodes: AkgNode[];
  edges: AkgEdge[];
}

export interface ImpactReport {
  targetNode: AkgNode;
  directlyAffected: AkgNode[];
  transitivelyAffected: AkgNode[];
  riskScore: number;
  summary: string;
}

export interface ImpactResponse {
  report: ImpactReport;
  cycles: { path: string[] }[];
}

export interface PathResult {
  nodes: AkgNode[];
  edges: AkgEdge[];
  totalWeight: number;
}

export interface AkgStats {
  nodes: number;
  edges: number;
  chunks: number;
  embeddings: number;
  communities: number;
  dbSize: number;
}

export interface TopoSortEntry {
  node: AkgNode;
  depth: number;
}

export interface TopoSortResult {
  entries: TopoSortEntry[];
  cycleNodeIds: string[];
}

export interface EmbedPoint {
  x: number;
  y: number;
  chunkId: string;
  file: string;
  nodeId: string | null;
  community: number | null;
  preview: string;
}

export interface EmbedMapResponse {
  points: EmbedPoint[];
  count: number;
  note?: string;
}

// Base URL for API calls.
// In production (astrivya atlas CLI on port 4200): same-origin, use relative path.
// In dev (vite on port 5173): point to the CLI atlas server.
const BASE_URL = import.meta.env.VITE_AKG_API_URL || "";

async function apiFetch(path: string): Promise<Response> {
  const url = `${BASE_URL}/api/akg${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (!BASE_URL) {
      throw new Error(
        "AKG API unavailable. Run `astrivya atlas` to start the local server, " +
          "or set VITE_AKG_API_URL=http://localhost:4200 in your .env",
      );
    }
    throw new Error(`AKG API error (${res.status}): ${res.statusText}`);
  }
  return res;
}

export const akgClient = {
  async getFullGraph(): Promise<GraphData> {
    const res = await apiFetch("/graph");
    return res.json();
  },

  async getSubgraph(id: string, radius = 2): Promise<GraphData> {
    const res = await apiFetch(`/subgraph?id=${encodeURIComponent(id)}&radius=${radius}`);
    return res.json();
  },

  async searchNodes(query: string): Promise<AkgNode[]> {
    const res = await apiFetch(`/search?q=${encodeURIComponent(query)}`);
    return res.json();
  },

  async getImpact(id: string): Promise<ImpactResponse> {
    const res = await apiFetch(`/impact?id=${encodeURIComponent(id)}`);
    return res.json();
  },

  async getPath(from: string, to: string): Promise<PathResult | null> {
    const res = await apiFetch(`/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    return res.json();
  },

  async getStats(): Promise<AkgStats> {
    const res = await apiFetch("/stats");
    return res.json();
  },

  async getTopo(): Promise<TopoSortResult> {
    const res = await apiFetch("/topo");
    return res.json();
  },

  async getEmbedMap(): Promise<EmbedMapResponse> {
    const res = await apiFetch("/embedmap");
    return res.json();
  },
};
