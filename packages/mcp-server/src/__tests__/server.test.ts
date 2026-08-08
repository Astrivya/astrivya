import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleReadResource, handleToolCall, setAkgStorage } from "../handlers";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
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
    expect(result.content[0].text).toContain("Decision logged");
    expect(result.content[0].text).toContain("decision::");
  });

  it("log_decision with file_context creates an edge", async () => {
    const result = await handleToolCall("log_decision", {
      title: "Use Tailwind",
      content: "Tailwind for styling",
      file_context: "src/frontend/package.json",
    });
    const decisionId = result.content[0].text.replace("Decision logged: ", "");
    const node = storage.getNode(decisionId);
    expect(node).not.toBeNull();
    expect(node!.label).toBe("Use Tailwind");

    const neighbors = storage.getNeighbors(decisionId);
    expect(neighbors.length).toBeGreaterThanOrEqual(1);
    expect(neighbors.some((n) => n.node.id === "file::package.json")).toBe(true);
  });

  it("log_memory creates a memory node with metadata", async () => {
    const result = await handleToolCall("log_memory", {
      content: "The team sprint starts on Tuesdays",
      type: "fact",
      visibility: "team",
    });
    expect(result.content[0].text).toContain("Memory stored");
    const memId = result.content[0].text.replace("Memory stored: ", "");
    const node = storage.getNode(memId);
    expect(node).not.toBeNull();
    expect(node!.type).toBe("agent_action");
    expect(node!.metadata).toContain("team");
  });

  it("get_person_context returns workspace stats", async () => {
    const result = await handleToolCall("get_person_context", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.workspace).toBe(dir);
    expect(typeof data.indexedFiles).toBe("number");
    expect(data.indexedFiles).toBeGreaterThan(0);
    expect(data.status).toBe("ready");
  });

  it("search_memories returns results (may be empty without embedder)", async () => {
    const result = await handleToolCall("search_memories", { query: "dark mode", limit: 5 });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
    // FTS/search results depend on embedder availability
    // In CI/test environment without a model, this may be empty
  });

  it("get_daily_briefing returns recent activity", async () => {
    const result = await handleToolCall("get_daily_briefing", { limit: 10 });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.date).toBeDefined();
    expect(Array.isArray(data.recentActivity)).toBe(true);
    expect(data.recentActivity.length).toBeGreaterThan(0);
    expect(data.note).toContain("Local AKG mode");
  });

  it("trace_decision returns node and relationships", async () => {
    const result = await handleToolCall("trace_decision", { decision_id: "memory::abc-123" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.decision.id).toBe("memory::abc-123");
    expect(Array.isArray(data.relationships)).toBe(true);
  });

  it("trace_decision returns error for missing decision", async () => {
    const result = await handleToolCall("trace_decision", { decision_id: "nonexistent" });
    expect(result.isError).toBeFalsy(); // not an error, returns a message
    expect(result.content[0].text).toContain("not found");
  });

  it("find_related_knowledge returns results", async () => {
    const result = await handleToolCall("find_related_knowledge", { term: "JWT auth", limit: 5 });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.term).toBe("JWT auth");
    expect(Array.isArray(data.results)).toBe(true);
  });

  it("get_team_context falls back to local AKG stats", async () => {
    const result = await handleToolCall("get_team_context", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.workspace).toBe(dir);
    expect(typeof data.nodes).toBe("number");
    expect(data.note).toContain("Cloud API unavailable");
  });

  it("get_team_members returns empty list in local mode", async () => {
    const result = await handleToolCall("get_team_members", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.members.length).toBe(0);
    expect(data.note).toContain("Local mode");
  });

  it("get_team_analytics returns local AKG stats in local mode", async () => {
    const result = await handleToolCall("get_team_analytics", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.nodes).toBe("number");
    expect(data.nodes).toBeGreaterThan(0);
    expect(data.note).toContain("Local mode");
  });

  it("list_notifications returns empty list in local mode", async () => {
    const result = await handleToolCall("list_notifications", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.notifications)).toBe(true);
    expect(data.notifications.length).toBe(0);
    expect(data.note).toContain("Local mode");
  });

  it("mark_notification_read returns ok in local mode", async () => {
    const result = await handleToolCall("mark_notification_read", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.note).toContain("Local mode");
  });

  it("get_expertise_profile falls back to local node type counts", async () => {
    const result = await handleToolCall("get_expertise_profile", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.workspace).toBe(dir);
    expect(Array.isArray(data.expertise)).toBe(true);
    expect(data.expertise.length).toBeGreaterThan(0);
    expect(data.note).toContain("Local AKG mode");
  });

  it("returns error for unknown tool", async () => {
    const result = await handleToolCall("unknown_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("uses default title when args are missing for log_decision", async () => {
    const result = await handleToolCall("log_decision", {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Decision logged: decision::/);
    const decisionId = result.content[0].text.replace("Decision logged: ", "");
    const node = storage.getNode(decisionId);
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
    const data = JSON.parse(result.contents[0].text);
    expect(data.workspace).toBe(dir);
    expect(typeof data.nodes).toBe("number");
  });

  it("reads user memories resource", async () => {
    const result = await handleReadResource("astrivya://user/active/memories");
    expect(result.contents.length).toBe(1);
    const data = JSON.parse(result.contents[0].text);
    expect(data.workspace).toBe(dir);
  });

  it("reads today's briefing resource", async () => {
    const result = await handleReadResource("astrivya://briefing/today");
    expect(result.contents.length).toBe(1);
    const data = JSON.parse(result.contents[0].text);
    expect(Array.isArray(data.recentActivity)).toBe(true);
  });

  it("reads org knowledge graph resource", async () => {
    const result = await handleReadResource("astrivya://org/knowledge-graph");
    expect(result.contents.length).toBe(1);
    const data = JSON.parse(result.contents[0].text);
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(data.nodes.length).toBeGreaterThan(0);
  });

  it("throws for unknown resource URI", async () => {
    await expect(handleReadResource("astrivya://unknown/path")).rejects.toThrow("Unsupported resource");
  });
});
