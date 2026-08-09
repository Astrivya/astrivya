/**
 * @astrivya/akg-core — embeddable knowledge graph engine for AI coding agents.
 *
 * Combines SQLite-embedded storage, FTS5 full-text search, 384-dim vector
 * embeddings, graph traversal, impact analysis, and 3-way merge sync.
 *
 * @example
 * ```ts
 * import { createAkg } from "@astrivya/akg-core";
 * const ctx = await createAkg("./my-project");
 * await ctx.storage.upsertNode({
 *   id: "doc:api",
 *   label: "API Design",
 *   type: "adr", content: "REST API with JWT auth",
 *   createdAt: Date.now(), updatedAt: Date.now(),
 * });
 * ```
 *
 * @packageDocumentation
 */

export { AkgStorage, SyncGraph } from "./akg-storage";
export { AkgQuery } from "./akg-query";
export {
  AkgChunk,
  AkgCommunity,
  AkgEdge,
  AkgNode,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  NodeType,
  QueryIntent,
  RelationType,
  RetrievalResult,
} from "./akg-types";
export { GraphTraversal, PathResult, TopoSortEntry, TopoSortResult } from "./core/traversal";
export { AstRelation, RelationshipEngine } from "./core/relationship-engine";
export { ImpactAnalyzer, ImpactReport } from "./core/impact";
export { mergeChunks, mergeEdges, mergeGraphs, mergeNode } from "./sync/merge";
export {
  AkgError,
  getErrorMessage,
  MergeError,
  NotFoundError,
  QueryError,
  StorageError,
  TraversalError,
  ValidationError,
} from "./errors";
export {
  createAkg,
  createImpactAnalyzer,
  createQuery,
  createStorage,
  createTraversal,
  withStorage,
  type AkgContext,
} from "./factory";
export {
  AppConfig,
  clearConfig,
  clearConfigCache,
  ensureConfigDir,
  isVerbose,
  loadConfig,
  saveConfig,
  setVerbose,
} from "./config";
export {
  CreditBalance,
  CreditResult,
  CreditSurface,
  CreditTransaction,
  CreditTransactionType,
  DebitResult,
} from "./credits";
