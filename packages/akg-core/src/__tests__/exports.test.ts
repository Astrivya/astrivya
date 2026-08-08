import { describe, expect, it } from "vitest";
import {
  AkgError,
  AkgQuery,
  AkgStorage,
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
});
