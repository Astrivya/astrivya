import { describe, expect, it } from "vitest";
import { computeCommunities, enumerateCommunities } from "../core/communities";

describe("computeCommunities", () => {
  it("puts connected nodes in the same community", () => {
    const assignment = computeCommunities(
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
      ["a", "b", "c", "d"],
    );
    expect(assignment.get("a")).toBe(assignment.get("b"));
    expect(assignment.get("b")).toBe(assignment.get("c"));
    expect(assignment.get("d")).not.toBe(assignment.get("a"));
  });

  it("keeps disconnected components separate", () => {
    const assignment = computeCommunities(
      [
        { source: "a", target: "b" },
        { source: "x", target: "y" },
      ],
      ["a", "b", "x", "y"],
    );
    expect(assignment.get("a")).toBe(assignment.get("b"));
    expect(assignment.get("x")).toBe(assignment.get("y"));
    expect(assignment.get("a")).not.toBe(assignment.get("x"));
  });

  it("assigns singletons their own community", () => {
    const assignment = computeCommunities([], ["a", "b"]);
    expect(assignment.get("a")).toBe(0);
    expect(assignment.get("b")).toBe(1);
    expect(assignment.get("a")).not.toBe(assignment.get("b"));
  });

  it("returns an empty map for no nodes", () => {
    expect(computeCommunities([], []).size).toBe(0);
  });
});

describe("enumerateCommunities", () => {
  it("counts internal edges and sorts by size", () => {
    const components = enumerateCommunities(
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "a", target: "c" },
        { source: "x", target: "y" },
      ],
      ["a", "b", "c", "x", "y"],
    );
    expect(components.length).toBe(2);
    expect(components[0].nodeIds).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(components[0].nodeIds).toHaveLength(3);
    expect(components[0].internalEdges).toBe(3);
    expect(components[1].nodeIds).toEqual(expect.arrayContaining(["x", "y"]));
  });
});
