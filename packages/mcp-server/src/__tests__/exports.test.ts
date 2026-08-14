import { describe, expect, it } from "vitest";

/**
 * The public MCP tool surface. This is the lock: any add/remove/rename in
 * CORE_TOOL_DEFINITIONS (packages/mcp-server/src/schemas.ts) fails the tests
 * below until this list is updated deliberately. Keep it in sync with
 * `npm run check:docs`, which verifies the README + both SKILL.md copies
 * against the same definitions.
 */
const EXPECTED_TOOLS = [
  "check_credits",
  "find_related_knowledge",
  "get_context_digest",
  "get_daily_briefing",
  "get_expertise_profile",
  "get_mcp_status",
  "get_person_context",
  "get_team_analytics",
  "get_team_context",
  "get_team_members",
  "get_workspace_updates",
  "identify_agent",
  "list_notifications",
  "log_decision",
  "log_memory",
  "mark_notification_read",
  "mesh_read",
  "agent_message",
  "search_connectors",
  "search_memories",
  "trace_decision",
].sort();

const EXPECTED_RESOURCE_COUNT = 4;

describe("@astrivya/mcp-server", () => {
  it("exports schemas (TOOL_DEFINITIONS, RESOURCE_DEFINITIONS)", async () => {
    // Dynamic import because the module has side effects (shebang)
    const schemas = await import("../schemas");
    expect(schemas.CORE_TOOL_DEFINITIONS).toBeDefined();
    expect(Array.isArray(schemas.CORE_TOOL_DEFINITIONS)).toBe(true);
    expect(schemas.RESOURCE_DEFINITIONS).toBeDefined();
    expect(Array.isArray(schemas.RESOURCE_DEFINITIONS)).toBe(true);
  });

  it("locks the exact tool set (add/remove/rename must update EXPECTED_TOOLS)", async () => {
    const schemas = await import("../schemas");
    const names = schemas.CORE_TOOL_DEFINITIONS.map((t: any) => t.name).sort();
    expect(names).toStrictEqual(EXPECTED_TOOLS);
    // Every tool must be fully specified (a missing schema silently breaks the
    // client's ability to call it).
    for (const t of schemas.CORE_TOOL_DEFINITIONS as any[]) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeDefined();
    }
    // Names must be unique — a duplicate would be shadowed in tools/list.
    expect(new Set(names).size).toBe(names.length);
  });

  it("locks the resource surface (4 resources)", async () => {
    const schemas = await import("../schemas");
    expect(schemas.RESOURCE_DEFINITIONS).toHaveLength(EXPECTED_RESOURCE_COUNT);
    for (const r of schemas.RESOURCE_DEFINITIONS as any[]) {
      expect(typeof r.uri).toBe("string");
      expect(typeof r.description).toBe("string");
    }
  });

  it("exports handlers", async () => {
    const handlers = await import("../handlers");
    expect(handlers.handleToolCall).toBeInstanceOf(Function);
    expect(handlers.handleReadResource).toBeInstanceOf(Function);
    expect(handlers.setAkgStorage).toBeInstanceOf(Function);
  });

  it("exports config (api module)", async () => {
    const api = await import("../api");
    expect(api.getConfig).toBeInstanceOf(Function);
  });

  it("exports the status module (journal + snapshots)", async () => {
    const status = await import("../status");
    expect(status.initStatus).toBeInstanceOf(Function);
    expect(status.recordToolCall).toBeInstanceOf(Function);
    expect(status.getStatus).toBeInstanceOf(Function);
    expect(status.readJournal).toBeInstanceOf(Function);
  });
});
