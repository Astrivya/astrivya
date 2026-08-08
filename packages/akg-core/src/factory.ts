import { AkgQuery } from "./akg-query";
import { AkgStorage } from "./akg-storage";
import { ImpactAnalyzer } from "./core/impact";
import { GraphTraversal } from "./core/traversal";
import { StorageError } from "./errors";

/** Aggregated AKG services for a workspace. */
export interface AkgContext {
  /** Initialized storage instance. */
  storage: AkgStorage;
  /** Query engine for semantic + graph search. */
  query: AkgQuery;
  /** Graph traversal utilities. */
  traversal: GraphTraversal;
  /** Impact analysis engine. */
  impact: ImpactAnalyzer;
}

/**
 * Create and initialize an AkgStorage for the given workspace.
 * The database is stored at `<workspacePath>/.astrivya/akg.db`.
 */
export async function createStorage(workspacePath: string): Promise<AkgStorage> {
  const storage = new AkgStorage();
  await storage.init(workspacePath);
  return storage;
}

/**
 * Create an AkgQuery bound to the given storage and workspace path.
 */
export function createQuery(storage: AkgStorage, workspacePath: string): AkgQuery {
  return new AkgQuery(storage, workspacePath);
}

/**
 * Create a GraphTraversal instance bound to the given storage.
 */
export function createTraversal(storage: AkgStorage): GraphTraversal {
  return new GraphTraversal(storage);
}

/**
 * Create an ImpactAnalyzer bound to the given storage.
 */
export function createImpactAnalyzer(storage: AkgStorage): ImpactAnalyzer {
  return new ImpactAnalyzer(storage);
}

/**
 * One-shot convenience: create + initialize storage, query, traversal,
 * and impact analyzer for the given workspace.
 */
export async function createAkg(workspacePath: string): Promise<AkgContext> {
  const storage = await createStorage(workspacePath);
  return {
    storage,
    query: createQuery(storage, workspacePath),
    traversal: createTraversal(storage),
    impact: createImpactAnalyzer(storage),
  };
}

/**
 * Wrap a storage operation with error handling.
 * Catches thrown errors and re-throws as a typed StorageError.
 */
export function withStorage<T>(storage: AkgStorage, fn: (store: AkgStorage) => Promise<T>): Promise<T> {
  try {
    return fn(storage);
  } catch (err) {
    throw new StorageError(err instanceof Error ? err.message : String(err), { operation: fn.name || "anonymous" });
  }
}
