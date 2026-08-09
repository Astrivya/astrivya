import { describe, expect, it } from "vitest";
import {
  AkgError,
  AkgQuery,
  AkgStorage,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  GraphTraversal,
  ImpactAnalyzer,
  MergeError,
  NotFoundError,
  QueryError,
  RelationshipEngine,
  StorageError,
  TraversalError,
  ValidationError,
  createAkg,
  createImpactAnalyzer,
  createQuery,
  createStorage,
  createTraversal,
  getErrorMessage,
  mergeChunks,
  mergeEdges,
  mergeGraphs,
  mergeNode,
  withStorage,
} from "../index";

describe("@astrivya/akg-core public API", () => {
  it("exports storage classes", () => {
    expect(AkgStorage).toBeDefined();
    expect(AkgQuery).toBeDefined();
  });

  it("exports graph algorithm classes", () => {
    expect(GraphTraversal).toBeDefined();
    expect(ImpactAnalyzer).toBeDefined();
    expect(RelationshipEngine).toBeDefined();
  });

  it("exports factory functions", () => {
    expect(createStorage).toBeInstanceOf(Function);
    expect(createQuery).toBeInstanceOf(Function);
    expect(createTraversal).toBeInstanceOf(Function);
    expect(createImpactAnalyzer).toBeInstanceOf(Function);
    expect(createAkg).toBeInstanceOf(Function);
    expect(withStorage).toBeInstanceOf(Function);
  });

  it("exports error classes", () => {
    expect(AkgError).toBeDefined();
    expect(StorageError).toBeDefined();
    expect(QueryError).toBeDefined();
    expect(TraversalError).toBeDefined();
    expect(MergeError).toBeDefined();
    expect(NotFoundError).toBeDefined();
    expect(ValidationError).toBeDefined();
    expect(getErrorMessage).toBeInstanceOf(Function);
  });

  it("exports merge functions", () => {
    expect(mergeGraphs).toBeInstanceOf(Function);
    expect(mergeNode).toBeInstanceOf(Function);
    expect(mergeEdges).toBeInstanceOf(Function);
    expect(mergeChunks).toBeInstanceOf(Function);
  });

  it("exposes the shared embedding model constants", () => {
    expect(EMBEDDING_MODEL).toBe("snowflake-arctic-embed-xs");
    expect(EMBEDDING_DIM).toBe(384);
  });

  it("AkgQuery exposes a query embedder", () => {
    const storage = new AkgStorage();
    const query = new AkgQuery(storage, ".");
    // embedQuery returns [] when the ONNX model is unavailable in CI — it
    // must never throw.
    expect(query.embedQuery).toBeInstanceOf(Function);
    const result = query.embedQuery("test query");
    expect(result).toBeInstanceOf(Promise);
  });
});
