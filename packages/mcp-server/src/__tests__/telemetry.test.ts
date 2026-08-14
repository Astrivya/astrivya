import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCapturePayload,
  capture,
  captureForbiddenKeys,
  isTelemetryEnabled,
  telemetryServerStart,
  telemetrySessionEnd,
  telemetrySessionStart,
  telemetrySetTransport,
  telemetryToolCall,
} from "../telemetry";

describe("mcp-server telemetry", () => {
  beforeEach(() => {
    process.env.APPDATA = path.join(os.tmpdir(), "astrivya-mcp-test", String(Date.now()));
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "astrivya-mcp-test", String(Date.now()));
    process.env.ASTRIVYA_TELEMETRY = "";
    process.env.NO_TELEMETRY = "";
    process.env.CI = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.ASTRIVYA_TELEMETRY = "";
    process.env.NO_TELEMETRY = "";
    process.env.CI = "";
  });

  it("is enabled by default (opt-out)", () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("is disabled via ASTRIVYA_TELEMETRY=off", () => {
    process.env.ASTRIVYA_TELEMETRY = "off";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("is disabled in CI", () => {
    process.env.CI = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("does not send when disabled", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.CI = "1";
    capture("oss_mcp_session_start", { transport: "stdio" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(() => capture("oss_mcp_session_start", { transport: "stdio" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("payload has the expected shape and product tag", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    capture("oss_mcp_session_start", { transport: "http" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.event).toBe("oss_mcp_session_start");
    expect(body.properties.product).toBe("mcp-server");
    expect(body.properties.transport).toBe("http");
    expect(body.properties.install_id).toBeTruthy();
    expect(body.distinct_id).toBe(body.properties.install_id);
  });

  it("payload never contains forbidden fields", () => {
    const payload = buildCapturePayload("oss_mcp_tool_call", {
      tool: "search_memories",
      arguments: { q: "secret query" },
      token: "secret",
      query: "SELECT 1",
    });
    expect(Object.keys(payload.properties)).not.toContain("arguments");
    expect(Object.keys(payload.properties)).not.toContain("token");
    expect(Object.keys(payload.properties)).not.toContain("query");
    for (const key of captureForbiddenKeys) {
      expect(Object.keys(payload.properties)).not.toContain(key);
    }
  });

  it("tool calls are sampled once per (session, tool)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetrySetTransport("stdio");
    telemetryToolCall({ sessionId: "s1", tool: "search_memories", ok: true, durationMs: 12 });
    telemetryToolCall({ sessionId: "s1", tool: "search_memories", ok: false, durationMs: 3 });
    telemetryToolCall({ sessionId: "s1", tool: "get_team_context", ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const events = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).event);
    expect(events).toEqual(["oss_mcp_tool_call", "oss_mcp_tool_call"]);
  });

  it("server start event includes transport and version", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetrySetTransport("http");
    telemetryServerStart("0.3.0");
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.event).toBe("oss_mcp_server_start");
    expect(body.properties.transport).toBe("http");
    expect(body.properties.server_version).toBe("0.3.0");
  });

  it("session end includes tool call count", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetrySessionStart({ sessionId: "s1", client: "claude" });
    telemetrySessionEnd({ sessionId: "s1", toolCalls: 7 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const startBody = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(startBody.event).toBe("oss_mcp_session_start");
    expect(startBody.properties.client_type).toBe("claude");
    const endBody = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
    expect(endBody.event).toBe("oss_mcp_session_end");
    expect(endBody.properties.tool_calls).toBe(7);
  });
});
