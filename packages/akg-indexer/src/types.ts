/** Kind of a workspace unit discovered by the workspace scanner. */
export type WorkspaceUnitKind = "git-repo" | "workspace-root" | "folder" | "loose";

/** One indexable unit of the workspace: a git repo, a workspace root, a plain folder, or loose root files. */
export interface WorkspaceUnit {
  /** Display name (folder basename, or "(workspace root)" for loose files). */
  name: string;
  /** Absolute path. */
  path: string;
  kind: WorkspaceUnitKind;
  /** Marker files found in this unit (".git", "package.json", "pnpm-workspace.yaml", ...). */
  markers: string[];
  /** Indexable files (fast pre-scan, readdir-only). 0 when the unit is empty. */
  fileCount: number;
  /** Names of git repos nested directly inside (for workspace-root units). */
  nestedRepos: string[];
}

/** Result of scanning a workspace for indexable units (repos/folders). */
export interface WorkspaceMap {
  root: string;
  rootIsRepo: boolean;
  units: WorkspaceUnit[];
  totalFiles: number;
  /** Top-level dirs skipped because they are in the skip list (node_modules, .git, dist, ...). */
  skippedTopLevel: string[];
}

/** Phases of the index pipeline, reported through {@link IndexProgressEvent}. */
export type IndexPhase = "detect" | "agent" | "todos" | "code" | "merge" | "adr" | "relations" | "save" | "done";

/**
 * Structured progress event emitted during indexing.
 * Per-file events carry {@link unitIndex} + {@link file}; unit boundary events
 * carry {@link unitStart} / {@link unitComplete}.
 */
export interface IndexProgressEvent {
  phase: IndexPhase;
  /** Human-readable one-liner for the current action (optional). */
  message?: string;
  unitIndex?: number;
  unitCount?: number;
  unitName?: string;
  unitKind?: WorkspaceUnitKind;
  unitStart?: boolean;
  unitComplete?: boolean;
  unitFilesDone?: number;
  unitFilesTotal?: number;
  unitErrors?: number;
  /** Current file being indexed (workspace-relative). */
  file?: string;
  /** Files walked so far across all units. */
  filesDone?: number;
  /** Total indexable files across all units (0/undefined when unknown). */
  filesTotal?: number;
  nodes?: number;
  edges?: number;
  chunks?: number;
  errors?: number;
  filesPerSec?: number;
  elapsedMs?: number;
  /** EWMA-smoothed estimated time remaining (aggregator-computed). */
  etaMs?: number;
  /** Total workers in the pool (parallel mode only). */
  workerCount?: number;
  /** Workers currently processing a unit. */
  activeWorkers?: number;
  /** Units still queued (parallel mode only). */
  unitPending?: number;
  /** Worker that produced this event (parallel mode only). */
  workerId?: number;
}

/** Result of {@link AkgIndexer.indexWorkspaceDetailed}. */
export interface IndexResult {
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  indexed: number;
  failed: number;
  chunks: number;
  elapsedMs: number;
  workersUsed: number;
  units: Array<{ name: string; files: number; chunks: number; symbols: number; errors: number }>;
}

/** Per-file walk outcome used by the code chunker. */
export interface FileIndexResult {
  indexed: boolean;
  chunks: number;
  symbols: number;
}
