/** Supported node types in the knowledge graph. */
export type NodeType =
  | "workspace"
  | "folder"
  | "file"
  | "function"
  | "class"
  | "interface"
  | "document"
  | "dependency"
  | "adr"
  | "person"
  | "task"
  | "agent"
  | "agent_action";

/** Supported edge relation types between nodes. */
export type RelationType =
  | "contains"
  | "imports"
  | "exports"
  | "depends_on"
  | "documents"
  | "related_to"
  | "calls"
  | "uses"
  | "implements"
  | "extends"
  | "references"
  | "owns"
  | "created_by"
  | "decides"
  | "supersedes"
  | "blocks"
  | "enables"
  | "tracked_by"
  | "generated"
  | "modified"
  | "executed";

/** A node in the knowledge graph (file, function, concept, person, etc.). */
export interface AkgNode {
  id: string;
  label: string;
  type: NodeType;
  sourceFile?: string;
  sourceLocation?: string;
  content?: string;
  contentHash?: string;
  community?: number;
  churnRate?: number;
  lastModified?: number;
  contributorCount?: number;
  metadata?: string; // JSON string
  createdAt: number;
  updatedAt: number;
}

/** A directed edge between two graph nodes. */
export interface AkgEdge {
  id?: number;
  source: string;
  target: string;
  relation: RelationType;
  weight?: number;
  confidence?: number;
  extractionMethod?: string;
  metadata?: string; // JSON string
}

/** A content chunk (code snippet, doc section) indexed in the graph. */
export interface AkgChunk {
  id: string;
  nodeId?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  content: string;
  contentHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AkgCommunity {
  id: number;
  label?: string;
  nodeCount?: number;
  cohesion?: number;
  metadata?: string; // JSON string
}

/** Weights for multi-strategy query fusion. */
export interface QueryIntent {
  ftsWeight: number;
  semanticWeight: number;
  graphWeight: number;
}

export interface RetrievalResult {
  chunkId?: string;
  nodeId?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  content: string;
  score: number;
  source: "fts" | "semantic" | "graph";
  /** Unix ms when the item was first indexed. */
  createdAt?: number;
  /** Unix ms when the item was last verified/re-indexed. */
  lastVerifiedAt?: number;
  /** True when the chunk/node is older than the staleness threshold. */
  stale?: boolean;
}
