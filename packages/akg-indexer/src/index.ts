// Astrivya AKG Indexer

export { AdrParser } from "./adr-parser";
export { AgentParser } from "./agent-parser";
export { CodeChunker, SKIP_DIRS, CODE_EXTENSIONS, isIndexableFileName } from "./code-chunker";
export { TodoParser } from "./todo-parser";
export { AkgEmbedder } from "./embedder";
export { AkgIndexer } from "./indexer";
export type { IndexWorkspaceOptions } from "./indexer";
export { Watcher } from "./watcher";
export type { WatcherOptions } from "./watcher";
export {
  computeMaxWorkers,
  computeMemoryCap,
  computeNextWorkerCount,
  indexUnitsParallel,
  resolveWorkerPath,
} from "./parallel";
export type { ParallelIndexOptions, ParallelIndexResult, ParallelUnitResult } from "./parallel";
export {
  detectMarkers,
  isGitRepo,
  scanWorkspace,
  summarizeUnits,
  WORKSPACE_MARKER_FILES,
} from "./workspace-map";
export { buildIdentityGraph } from "./identity";
export type { IdentityBuildResult, RepoIdentity } from "./identity";
export type {
  FileIndexResult,
  IndexPhase,
  IndexProgressEvent,
  IndexResult,
  WorkspaceMap,
  WorkspaceUnit,
  WorkspaceUnitKind,
} from "./types";
