import { describe, expect, it } from "vitest";

describe("@astrivya/cli", () => {
  it("exports command registration functions from registered commands", async () => {
    const commands = [
      "../commands/akg",
      "../commands/atlas",
      "../commands/config",
      "../commands/doctor",
      "../commands/hooks",
      "../commands/init",
      "../commands/local",
      "../commands/mcp-server",
      "../commands/runtime",
      "../commands/setup",
      "../commands/status",
      "../commands/sync",
      "../commands/update",
    ];

    for (const cmdPath of commands) {
      const mod = await import(cmdPath);
      // Each module should export a register* function
      const exportKeys = Object.keys(mod);
      expect(exportKeys.length).toBeGreaterThan(0);
    }
  });

  it("exports compat module with required utilities", async () => {
    const compat = await import("../lib/compat");
    expect(compat.apiCall).toBeInstanceOf(Function);
    expect(compat.loadConfig).toBeInstanceOf(Function);
    expect(compat.saveConfig).toBeInstanceOf(Function);
    expect(compat.getToken).toBeInstanceOf(Function);
    expect(compat.getBaseUrl).toBeInstanceOf(Function);
  });

  it("sanitizes HTML bodies out of API error messages", async () => {
    const compat = await import("../lib/compat");
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/></head><body>404</body></html>';
    expect(compat.sanitizeApiErrorBody(html)).toContain("HTML");
    expect(compat.sanitizeApiErrorBody('{"error":"nope"}')).toBe('{"error":"nope"}');
    expect(compat.sanitizeApiErrorBody("x".repeat(2000))).toHaveLength(500);
  });
});
