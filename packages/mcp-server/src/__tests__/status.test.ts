import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusModule = typeof import("../status");

let tmpDir = "";
let status: StatusModule;

/** Fresh module instance per test — status.ts keeps process-level state. */
async function freshModule(): Promise<StatusModule> {
  vi.resetModules();
  return import("../status");
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-status-"));
  status = await freshModule();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mcp-server status module", () => {
  it("records sessions and tool counters with per-tool stats", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    status.recordSessionStart({ client: "opencode" });
    status.recordSessionEnd();
    status.recordToolCall("search_memories", true, { durationMs: 10 });
    status.recordToolCall("log_decision", false, { durationMs: 20 });

    const s = status.getStatus();
    expect(s.version).toBe("1.0.0");
    expect(s.mode).toBe("stdio");
    expect(s.workspace).toBe(tmpDir);
    expect(s.sessions).toBe(1);
    expect(s.activeSessions).toBe(0);
    expect(s.toolCalls).toBe(2);
    expect(s.toolErrors).toBe(1);
    expect(s.tools.search_memories).toMatchObject({ count: 1, errors: 0 });
    expect(s.tools.log_decision).toMatchObject({ count: 1, errors: 1 });
    expect(s.startedAt).toBeGreaterThan(0);
    expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("maintains a live session registry keyed by session id", () => {
    status.initStatus({ workspace: tmpDir, mode: "http", version: "1.0.0" });
    const sid = status.recordSessionStart({ id: "http:abc", client: "claude", mode: "http" });
    status.recordToolCall("search_memories", true, { sessionId: sid, durationMs: 5 });
    status.recordToolCall("log_decision", false, { sessionId: sid });
    status.recordToolCall("search_memories", true, { sessionId: "http:other" }); // unknown session: global only

    let s = status.getStatus();
    expect(s.activeSessions).toBe(1);
    expect(s.sessionsList).toHaveLength(1);
    const sess = s.sessionsList[0];
    expect(sess.id).toBe("http:abc");
    expect(sess.client).toBe("claude");
    expect(sess.mode).toBe("http");
    expect(sess.toolCalls).toBe(2);
    expect(sess.tools).toEqual({ search_memories: 1, log_decision: 1 });
    expect(sess.lastTool).toBe("log_decision");
    expect(sess.lastToolAt).toBeGreaterThan(0);
    expect(sess.endedAt).toBeNull();

    status.recordSessionEnd(sid);
    s = status.getStatus();
    expect(s.activeSessions).toBe(0);
    expect(s.sessionsList[0].endedAt).not.toBeNull();
  });

  it("computes p50/p95 latency from bounded samples", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    for (let i = 1; i <= 100; i++) {
      status.recordToolCall("slow_tool", true, { durationMs: i });
    }
    const stats = status.getStatus().tools.slow_tool;
    expect(stats.count).toBe(100);
    expect(stats.lastMs).toBe(100);
    expect(stats.p50Ms).toBeGreaterThanOrEqual(49);
    expect(stats.p50Ms).toBeLessThanOrEqual(51);
    expect(stats.p95Ms).toBeGreaterThanOrEqual(94);
    expect(stats.p95Ms).toBeLessThanOrEqual(96);
  });

  it("auto-ends idle sessions during the sweep", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    const sid = status.recordSessionStart({ id: "http:idle", client: "atlas", mode: "http" });
    status.sweepIdleSessions(Date.now() + status.IDLE_SESSION_MS + 1000);
    const s = status.getStatus();
    expect(s.activeSessions).toBe(0);
    expect(s.sessionsList.find((x) => x.id === sid)?.endedAt).not.toBeNull();

    // Touching a session keeps it alive.
    const sid2 = status.recordSessionStart({ id: "http:busy", client: "atlas", mode: "http" });
    status.touchSession(sid2);
    status.sweepIdleSessions(Date.now() + status.IDLE_SESSION_MS - 1000);
    expect(status.getStatus().activeSessions).toBe(1);
  });

  it("re-registers an unknown session via ensureSession without double-counting", () => {
    status.initStatus({ workspace: tmpDir, mode: "http", version: "1.0.0" });
    status.ensureSession("http:reconnect", "cursor", "http");
    status.ensureSession("http:reconnect", "cursor", "http"); // already active — no-op
    status.recordSessionStart({ id: "http:reconnect" }); // active — no-op
    const s = status.getStatus();
    expect(s.sessions).toBe(1);
    expect(s.activeSessions).toBe(1);
  });

  it("writes and reads the workspace journal with session ids", () => {
    status.initStatus({ workspace: tmpDir, mode: "http", version: "1.0.0" });
    const sid = status.recordSessionStart({ id: "http:abc", client: "claude", mode: "http" });
    status.recordToolCall("get_person_context", true, { sessionId: sid, durationMs: 12 });
    status.recordServerStop("SIGINT");

    const file = status.journalPath(tmpDir);
    expect(fs.existsSync(file)).toBe(true);

    const events = status.readJournal(tmpDir, 100);
    expect(events.length).toBe(5);
    expect(events[0].type).toBe("server_start");
    expect(events[1].type).toBe("session_start");
    expect(events[1].session_id).toBe("http:abc");
    expect(events[1].client).toBe("claude");
    expect(events[2].type).toBe("tool_call");
    expect(events[2].tool).toBe("get_person_context");
    expect(events[2].ok).toBe(true);
    expect(events[2].session_id).toBe("http:abc");
    expect(events[2].duration_ms).toBe(12);
    expect(events[3].type).toBe("session_end");
    expect(events[4].type).toBe("server_stop");
  });

  it("returns an empty journal for unknown workspaces", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    expect(status.readJournal(path.join(tmpDir, "nope"), 10)).toEqual([]);
  });

  it("captures clientInfo from the initialize handshake onto sessions", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    status.captureClientInfo("stdio:123", "opencode", "0.5.0");
    const sid = status.recordSessionStart({ id: "stdio:123" });
    const info = status.getClientInfo(sid);
    expect(info.client).toBe("opencode");
    expect(info.version).toBe("0.5.0");
    const sess = status.getStatus().sessionsList.find((s) => s.id === sid);
    expect(sess?.client).toBe("opencode");
    expect(sess?.clientVersion).toBe("0.5.0");
  });

  it("attachClientIdentity fills the name gap and journals agent_identify", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    const sid = status.recordSessionStart({ id: "stdio:123", client: "stdio" });
    status.attachClientIdentity(sid, "opencode", "0.5.0");
    const sess = status.getStatus().sessionsList.find((s) => s.id === sid);
    expect(sess?.client).toBe("opencode");
    expect(sess?.clientVersion).toBe("0.5.0");
    expect(status.getAgentIdentity(sid).name).toBe("opencode");
    const events = status.readJournal(tmpDir, 100);
    const idEvent = events.find((e) => e.type === "agent_identify");
    expect(idEvent?.name).toBe("opencode");
    expect(idEvent?.session_id).toBe(sid);
  });

  it("attachClientIdentity never overrides an env-provided name", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    vi.stubEnv("ASTRIVYA_AGENT_NAME", "mesh-builder");
    const sid = status.recordSessionStart({ id: "stdio:env" });
    status.attachClientIdentity(sid, "opencode", "0.5.0");
    expect(status.getAgentIdentity(sid).name).toBe("mesh-builder");
    vi.unstubAllEnvs();
  });

  it("merges env identity with identify_agent overrides and journals the event", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    vi.stubEnv("ASTRIVYA_AGENT_NAME", "mesh-builder");
    vi.stubEnv("ASTRIVYA_AGENT_MODEL", "claude-sonnet-4");
    const sid = status.recordSessionStart({ id: "stdio:abc" });
    const merged = status.setAgentIdentity(sid, { model: "opencode/claude-sonnet-4", project: "astrivya" });
    expect(merged.name).toBe("mesh-builder"); // env fallback
    expect(merged.model).toBe("opencode/claude-sonnet-4"); // explicit wins
    expect(merged.project).toBe("astrivya");
    expect(status.getAgentIdentity(sid).provider).toBeNull();

    const events = status.readJournal(tmpDir, 100);
    const idEvent = events.find((e) => e.type === "agent_identify");
    expect(idEvent).toBeTruthy();
    expect(idEvent?.session_id).toBe(sid);
    expect(idEvent?.name).toBe("mesh-builder");
    expect(idEvent?.project).toBe("astrivya");
    vi.unstubAllEnvs();
  });

  it("keeps self-registered identity even without a session row", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    status.setAgentIdentity("stdio:ghost", { name: "ghost", model: "m" });
    expect(status.getAgentIdentity("stdio:ghost")).toMatchObject({ name: "ghost", model: "m" });
  });

  it("reads and filters the agent mesh feed from the journal", () => {
    status.initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    const sid = status.recordSessionStart({ id: "stdio:1" });
    status.setAgentIdentity(sid, { name: "alpha" });
    status.recordEvent(
      "agent_message",
      {
        id: "mesh::1",
        from: sid,
        from_name: "alpha",
        to: "all",
        msg_type: "code-conflict",
        urgency: "high",
        text: "I'm editing cli.ts:12-40",
        thread_id: "release-1",
        pid: process.pid,
      },
      tmpDir,
    );
    status.recordEvent(
      "agent_message",
      {
        id: "mesh::2",
        from: "stdio:2",
        from_name: "beta",
        to: "all",
        msg_type: "general",
        text: "ok, deferring",
        thread_id: "release-1",
        pid: 999999,
      },
      tmpDir,
    );

    const all = status.readMeshMessages(tmpDir, {});
    expect(all).toHaveLength(2);
    expect(all[0].threadId).toBe("release-1");
    expect(all[0].text).toContain("cli.ts:12-40");
    expect(all[1].text).toBe("ok, deferring");

    expect(status.readMeshMessages(tmpDir, { type: "code-conflict" })).toHaveLength(1);
    expect(status.readMeshMessages(tmpDir, { agent: sid })).toHaveLength(1);
    expect(status.readMeshMessages(tmpDir, { since: new Date(Date.now() + 1000).toISOString() })).toHaveLength(0);
    const limited = status.readMeshMessages(tmpDir, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe("mesh::2");
  });
});
