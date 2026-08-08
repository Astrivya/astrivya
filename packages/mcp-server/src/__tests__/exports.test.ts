import { describe, expect, it } from "vitest";

describe("@astrivya/mcp-server", () => {
  it("exports schemas (TOOL_DEFINITIONS, RESOURCE_DEFINITIONS)", async () => {
    // Dynamic import because the module has side effects (shebang)
    const schemas = await import("../schemas");
    expect(schemas.CORE_TOOL_DEFINITIONS).toBeDefined();
    expect(Array.isArray(schemas.CORE_TOOL_DEFINITIONS)).toBe(true);
    expect(schemas.RESOURCE_DEFINITIONS).toBeDefined();
    expect(Array.isArray(schemas.RESOURCE_DEFINITIONS)).toBe(true);
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
});
