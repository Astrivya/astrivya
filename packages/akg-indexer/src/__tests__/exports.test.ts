import { describe, expect, it } from "vitest";
import { AdrParser, AgentParser, AkgEmbedder, AkgIndexer, TodoParser } from "../index";

describe("@astrivya/akg-indexer public API", () => {
  it("exports all parser classes", () => {
    expect(AdrParser).toBeDefined();
    expect(AgentParser).toBeDefined();
    expect(TodoParser).toBeDefined();
  });

  it("exports embedder and indexer", () => {
    expect(AkgEmbedder).toBeDefined();
    expect(AkgIndexer).toBeDefined();
  });
});
