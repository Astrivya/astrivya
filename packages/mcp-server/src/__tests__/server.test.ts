import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleReadResource, handleToolCall, setAkgStorage } from "../handlers";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Parse a tool result into the canonical envelope `{ data, source, freshness, note, meta }`. */
function parseEnvelope(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

/** Parse a resource read into the canonical envelope. */
function parseResource(result: { contents: Array<{ uri: string; mimeType: string; text: string }> }): any {
  return JSON.parse(result.contents[0].text);
}

describe("MCP server handlers — tools", () => {
  let dir: string;
  let storage: AkgStorage;

  beforeAll(async () => {
    dir = createTempDir();
    storage = new AkgStorage();
    await storage.init(dir);
    setAkgStorage(storage, dir);

    // Seed some initial data
    storage.upsertNode({
      id: "memory::abc-123",
      label: "User prefers dark mode",
      type: "agent_action",
      content: "The user explicitly stated they prefer dark mode in the IDE",
      createdAt: 1000,
      updatedAt: 1000,
    });
    storage.upsertNode({
      id: "memory::def-456",
      label: "Auth uses JWT",
      type: "agent_action",
      content: "Authentication is handled via JWT tokens with refresh rotation",
      createdAt: 1000,
      updatedAt: 1000,
    });
    // Need chunks for FTS search
    storage.upsertChunk({
      id: "chunk:dark",
      nodeId: "memory::abc-123",
      filePath: "notes.md",
      content: "dark mode preferences UI theme",
      createdAt: 1000,
      updatedAt: 1000,
    });
    storage.upsertChunk({
      id: "chunk:jwt",
      nodeId: "memory::def-456",
      filePath: "notes.md",
      content: "JWT token authentication refresh rotation",
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  afterAll(() => {
    cleanup(dir);
  });

  it("log_decision creates a node and returns its id", async () => {
    const result = await handleToolCall("log_decision", {
      title: "Use React",
      content: "We chose React for the frontend",
    });
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.id).toMatch(/^decision::/);
    expect(storage.getNode(body.data.id)).not.toBeNull();
  });

  it("log_decision with file_context creates an edge", async () => {
    const result = await handleToolCall("log_decision", {
      title: "Use Tailwind",
      content: "Tailwind for styling",
      file_context: "src/frontend/package.json",
    });
    const body = parseEnvelope(result);
    const decisionId = body.data.id;
    const node = storage.getNode(decisionId);
    expect(node).not.toBeNull();
    expect(node!.label).toBe("Use Tailwind");

    const neighbors = storage.getNeighbors(decisionId);
    expect(neighbors.length).toBeGreaterThanOrEqual(1);
    expect(neighbors.some((n) => n.node.id === "file::src/frontend/package.json")).toBe(true);
  });

  it("log_memory creates a memory node with metadata", async () => {
    const result = await handleToolCall("log_memory", {
      content: "The team sprint starts on Tuesdays",
      type: "fact",
      visibility: "team",
    });
    const body = parseEnvelope(result);
    const memId = body.data.id;
    const node = storage.getNode(memId);
    expect(node).not.toBeNull();
    expect(node!.type).toBe("agent_action");
    expect(node!.metadata).toContain("team");
  });

  it("get_person_context returns workspace stats", async () => {
    const result = await handleToolCall("get_person_context", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.workspace).toBe(dir);
    expect(typeof body.data.indexedFiles).toBe("number");
    expect(body.data.indexedFiles).toBeGreaterThan(0);
    expect(body.data.status).toBe("ready");
    // Canonical envelope: source + freshness always present
    expect(body.source).toBe("local");
    expect(body.freshness.fetchedAt).toBeDefined();
    expect(body.meta.cost).toBeDefined();
  });

  it("search_memories returns results (may be empty without embedder)", async () => {
    const result = await handleToolCall("search_memories", { query: "dark mode", limit: 5 });
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(Array.isArray(body.data.results)).toBe(true);
    // FTS (keyword) fallback must work even when no embeddings exist —
    // retrieve() fuses FTS + semantic + graph, so the seeded chunk matches.
    expect(body.data.results.length).toBeGreaterThan(0);
    expect(body.data.results[0].content).toContain("dark mode");
    // Envelope is self-describing: when semantic is unavailable the `note`
    // names the FTS fallback, so an empty array is not misread as "no data".
    if (body.note) {
      expect(body.note).toContain("keyword (FTS)");
    }
  });

  it("get_daily_briefing returns recent activity + prose summary", async () => {
    const result = await handleToolCall("get_daily_briefing", { limit: 10 });
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.date).toBeDefined();
    expect(Array.isArray(body.data.recentActivity)).toBe(true);
    expect(body.data.recentActivity.length).toBeGreaterThan(0);
    expect(body.data.summary).toBeTruthy();
    expect(Array.isArray(body.data.action_items)).toBe(true);
    expect(body.note).toContain("Local AKG mode");
  });

  it("trace_decision returns node and relationships", async () => {
    const result = await handleToolCall("trace_decision", { decision_id: "memory::abc-123" });
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.decision.id).toBe("memory::abc-123");
    expect(Array.isArray(body.data.relationships)).toBe(true);
  });

  it("trace_decision returns message for missing decision", async () => {
    const result = await handleToolCall("trace_decision", { decision_id: "nonexistent" });
    expect(result.isError).toBeFalsy(); // not an error, returns a message
    expect(result.content[0].text).toContain("not found");
  });

  it("find_related_knowledge returns results", async () => {
    const result = await handleToolCall("find_related_knowledge", { term: "JWT auth", limit: 5 });
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.term).toBe("JWT auth");
    expect(Array.isArray(body.data.results)).toBe(true);
  });

  it("get_team_context falls back to local AKG stats", async () => {
    const result = await handleToolCall("get_team_context", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.workspace).toBe(dir);
    expect(typeof body.data.nodes).toBe("number");
    expect(body.note).toContain("Cloud API unavailable");
  });

  it("get_team_members returns empty list in local mode", async () => {
    const result = await handleToolCall("get_team_members", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(Array.isArray(body.data.members)).toBe(true);
    expect(body.data.members.length).toBe(0);
    expect(body.note).toContain("Local mode");
  });

  it("get_team_analytics returns local AKG stats in local mode", async () => {
    const result = await handleToolCall("get_team_analytics", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(typeof body.data.nodes).toBe("number");
    expect(body.data.nodes).toBeGreaterThan(0);
    expect(body.note).toContain("Local mode");
  });

  it("list_notifications returns empty list in local mode", async () => {
    const result = await handleToolCall("list_notifications", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(Array.isArray(body.data.notifications)).toBe(true);
    expect(body.data.notifications.length).toBe(0);
    expect(body.note).toContain("Local mode");
  });

  it("mark_notification_read returns ok in local mode", async () => {
    const result = await handleToolCall("mark_notification_read", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.ok).toBe(true);
    expect(body.note).toContain("Local mode");
  });

  it("check_credits reports cloud-not-configured in local mode", async () => {
    // Machine/CI environments may set ASTRIVYA_TOKEN (or ASTRIVYA_API_KEY),
    // which would route check_credits to a real cloud call instead of the
    // local-mode branch. Stub them away for this one test (vitest restores).
    vi.stubEnv("ASTRIVYA_TOKEN", "");
    vi.stubEnv("ASTRIVYA_API_KEY", "");
    try {
      const result = await handleToolCall("check_credits", {});
      expect(result.isError).toBeFalsy();
      const body = parseEnvelope(result);
      expect(body.data.error).toContain("Not connected to cloud");
      expect(body.note).toContain("Cloud not configured");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("get_expertise_profile falls back to local node type counts", async () => {
    const result = await handleToolCall("get_expertise_profile", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.workspace).toBe(dir);
    expect(Array.isArray(body.data.expertise)).toBe(true);
    expect(body.data.expertise.length).toBeGreaterThan(0);
    expect(body.note).toContain("Local AKG mode");
  });

  it("get_context_digest returns a compact prose digest", async () => {
    const result = await handleToolCall("get_context_digest", { limit: 10 });
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.digest.summary).toBeTruthy();
    expect(Array.isArray(body.data.digest.action_items)).toBe(true);
    expect(body.data.approx_tokens).toBeLessThan(1500); // R1 budget
  });

  it("get_workspace_updates returns a delta with cursor", async () => {
    const result = await handleToolCall("get_workspace_updates", { since: "1970-01-01T00:00:00.000Z" });
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(Array.isArray(body.data.updates)).toBe(true);
    expect(body.data.updates.length).toBeGreaterThan(0);
    expect(body.data.has_more).toBe(false);
  });

  it("returns error for unknown tool", async () => {
    const result = await handleToolCall("unknown_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("uses default title when args are missing for log_decision", async () => {
    const result = await handleToolCall("log_decision", {});
    expect(result.isError).toBeFalsy();
    const body = parseEnvelope(result);
    expect(body.data.id).toMatch(/^decision::/);
    const node = storage.getNode(body.data.id);
    expect(node).not.toBeNull();
    expect(node!.label).toBe("Untitled Decision");
  });
});

describe("MCP server handlers — resources", () => {
  let dir: string;
  let storage: AkgStorage;

  beforeAll(async () => {
    dir = createTempDir();
    storage = new AkgStorage();
    await storage.init(dir);
    setAkgStorage(storage, dir);

    storage.upsertNode({
      id: "file:readme",
      label: "README",
      type: "file",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  afterAll(() => {
    cleanup(dir);
  });

  it("reads team knowledge resource", async () => {
    const result = await handleReadResource("astrivya://team/active/knowledge");
    expect(result.contents.length).toBe(1);
    const body = parseResource(result);
    expect(body.data.workspace).toBe(dir);
    expect(typeof body.data.stats.nodes).toBe("number");
  });

  it("reads user memories resource", async () => {
    const result = await handleReadResource("astrivya://user/active/memories");
    expect(result.contents.length).toBe(1);
    const body = parseResource(result);
    expect(body.data.workspace).toBe(dir);
  });

  it("reads today's briefing resource", async () => {
    const result = await handleReadResource("astrivya://briefing/today");
    expect(result.contents.length).toBe(1);
    const body = parseResource(result);
    expect(Array.isArray(body.data.recentActivity)).toBe(true);
  });

  it("reads org knowledge graph resource", async () => {
    const result = await handleReadResource("astrivya://org/knowledge-graph");
    expect(result.contents.length).toBe(1);
    const body = parseResource(result);
    expect(Array.isArray(body.data.nodes)).toBe(true);
    expect(body.data.nodes.length).toBeGreaterThan(0);
  });

  it("throws for unknown resource URI", async () => {
    await expect(handleReadResource("astrivya://unknown/path")).rejects.toThrow("Unsupported resource");
  });
});
