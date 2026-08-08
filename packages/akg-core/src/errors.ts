/**
 * Safely extract an error message from any thrown value.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Base error class for all Astrivya AKG errors.
 * Carries a machine-readable error code and optional details payload.
 */
export class AkgError extends Error {
  constructor(
    message: string,
    /** Machine-readable error code (e.g. `STORAGE_ERR`, `NOT_FOUND`). */
    public readonly code: string = "AKG_ERR",
    /** Optional structured data describing the error context. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AkgError";
  }
}

/**
 * Thrown when a storage operation fails (I/O, SQL, schema, etc.).
 */
export class StorageError extends AkgError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "STORAGE_ERR", details);
    this.name = "StorageError";
  }
}

/**
 * Thrown when a query operation fails (invalid query, empty result, etc.).
 */
export class QueryError extends AkgError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "QUERY_ERR", details);
    this.name = "QueryError";
  }
}

/**
 * Thrown when a graph traversal fails (cycle detected, max depth exceeded, etc.).
 */
export class TraversalError extends AkgError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "TRAVERSAL_ERR", details);
    this.name = "TraversalError";
  }
}

/**
 * Thrown when a graph merge operation encounters a conflict.
 */
export class MergeError extends AkgError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "MERGE_ERR", details);
    this.name = "MergeError";
  }
}

/**
 * Thrown when a requested entity (node, edge, chunk) is not found.
 */
export class NotFoundError extends AkgError {
  constructor(entityType: string, id: string) {
    super(`${entityType} not found: ${id}`, "NOT_FOUND", { entityType, id });
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when input data fails validation (missing fields, bad format, etc.).
 */
export class ValidationError extends AkgError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERR", details);
    this.name = "ValidationError";
  }
}
