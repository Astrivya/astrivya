import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveMeshSessions } from "../commands/atlas";

function ev(partial: Record<string, unknown>): Record<string, unknown> {
  return { ts: new Date().toISOString(), ...partial };
}

const identityById = new Map([
  [
    "sess-1",
    {
      id: "sess-1",
      name: "alpha",
      model: "claude-sonnet-4",
      provider: "opencode",
      session: null,
      cwd: null,
      project: "astrivya",
      pid: 1000,
      lastSeen: new Date().toISOString(),
    },
  ],
]);

describe("deriveMeshSessions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("classifies sessions active/orphan/ended by pid liveness", () => {
    const events = [
      ev({ type: "session_start", session_id: "sess-1", client: "opencode", pid: 1000 }),
      ev({ type: "session_start", session_id: "sess-2", client: "stdio", pid: 2000 }),
      ev({ type: "session_start", session_id: "sess-3", client: "claude", pid: 3000 }),
      ev({ type: "session_end", session_id: "sess-3" }),
      ev({ type: "tool_call", session_id: "sess-1", tool: "log_decision" }),
    ];
    const sessions = deriveMeshSessions(events, identityById, (pid) => pid === 1000 || pid === 3000);
    expect(sessions.map((s) => s.state)).toEqual(["active", "orphan", "ended"]);
    const active = sessions[0];
    expect(active.id).toBe("sess-1");
    expect(active.client).toBe("opencode");
    expect(active.toolCalls).toBe(1);
    expect(active.lastTool).toBe("log_decision");
    expect(active.agent?.name).toBe("alpha");
    expect(active.agent?.project).toBe("astrivya");
  });

  it("marks pid-keyed legacy sessions and keeps their sort last", () => {
    const events = [
      ev({ ts: "2026-08-15T10:00:00.000Z", type: "session_start", pid: 900, client: "legacy" }),
      ev({
        ts: "2026-08-15T10:00:01.000Z",
        type: "session_start",
        session_id: "sess-1",
        client: "opencode",
        pid: 1000,
      }),
    ];
    const sessions = deriveMeshSessions(events, identityById, () => true);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].legacy).toBe(false);
    expect(sessions[1].legacy).toBe(true);
    expect(sessions[1].id).toBe("pid:900");
  });

  it("falls back to pid-keyed session_start rows for identity-less sessions", () => {
    const events = [
      ev({
        type: "session_start",
        session_id: "sess-9",
        client: "opencode",
        client_version: "0.5.0",
        mode: "stdio",
        pid: 5000,
      }),
    ];
    const sessions = deriveMeshSessions(events, new Map(), () => true);
    expect(sessions[0]).toMatchObject({
      id: "sess-9",
      client: "opencode",
      clientVersion: "0.5.0",
      mode: "stdio",
      agent: null,
      startedAt: expect.any(Number),
    });
  });
});
