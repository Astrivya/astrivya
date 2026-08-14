import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../handlers";
import { PROMPT_DEFINITIONS, buildPromptPrompt } from "../prompts";

describe("MCP prompts", () => {
  it("lists session_start, remember_after_task and decision_required", () => {
    const names = PROMPT_DEFINITIONS.map((p) => p.name);
    expect(names).toContain("session_start");
    expect(names).toContain("remember_after_task");
    expect(names).toContain("decision_required");
    for (const p of PROMPT_DEFINITIONS) {
      expect(p.description.length).toBeGreaterThan(10);
    }
  });

  it("session_start steers the agent through digest -> search -> related -> updates", () => {
    const text = buildPromptPrompt("session_start", undefined);
    expect(text).toContain("get_context_digest");
    expect(text).toContain("search_memories");
    expect(text).toContain("find_related_knowledge");
    expect(text).toContain("get_workspace_updates");
  });

  it("remember_after_task embeds the task summary and visibility", () => {
    const text = buildPromptPrompt("remember_after_task", {
      task_summary: "Shipped the RRF merge.",
      decision: "Adopted reciprocal rank fusion",
      file_context: "handlers.ts",
      visibility: "team",
    });
    expect(text).toContain("Shipped the RRF merge.");
    expect(text).toContain("team");
    expect(text).toContain("log_decision");
    expect(text).toContain("log_memory");
  });

  it("decision_required produces a log_decision call", () => {
    const text = buildPromptPrompt("decision_required", {
      title: "RRF over concatenation",
      reasoning: "Rank-based fusion is robust across score scales",
    });
    expect(text).toContain("RRF over concatenation");
    expect(text).toContain("log_decision");
  });

  it("throws for unknown prompts", () => {
    expect(() => buildPromptPrompt("nope", undefined)).toThrow(/Unknown prompt/);
  });
});

describe("reciprocalRankFusion", () => {
  const local = [
    { id: "a", score: 0.9 },
    { id: "b", score: 0.8 },
    { id: "c", score: 0.1 },
  ];
  const cloud = [
    { id: "c", score: 0.99 }, // same id as a local hit → deduped
    { id: "d", score: 0.7 },
  ];

  it("interleaves local and cloud by rank and dedupes by id", () => {
    const merged = reciprocalRankFusion(local, cloud, 10);
    // c ranks #1 in cloud and #3 in local → highest fused score; a (#1 local) next.
    expect(merged.map((r: any) => r.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("respects the limit", () => {
    const merged = reciprocalRankFusion(local, cloud, 2);
    expect(merged).toHaveLength(2);
  });

  it("handles empty inputs", () => {
    expect(reciprocalRankFusion([], [], 5)).toEqual([]);
    expect(reciprocalRankFusion(local, [], 5)).toHaveLength(3);
  });
});
