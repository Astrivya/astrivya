import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive, journalSessionRows, summarizeMcpJournal } from "../commands/mcp";

const tmpDirs: string[] = [];

function makeWorkspace(events: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  tmpDirs.push(dir);
  const journalDir = join(dir, ".astrivya", "mcp");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, "events.ndjson"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return dir;
}

const ts = "2026-08-14T08:00:00.000Z";

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("journalSessionRows", () => {
  it("classifies sessions by end event and pid liveness", () => {
    const events = [
      { type: "session_start", session_id: "a", pid: 1000, client: "node", ts },
      { type: "session_start", session_id: "b", pid: 2000, client: "stdio", ts },
      { type: "session_start", session_id: "c", pid: 3000, client: "http", ts },
      { type: "session_end", session_id: "c", ts },
      { type: "tool_call", session_id: "a", tool: "search_memories", ok: true, ts },
    ];
    const rows = journalSessionRows(events, (pid) => pid === 1000);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === "a")?.state).toBe("active");
    expect(rows.find((r) => r.id === "a")?.toolCalls).toBe(1);
    expect(rows.find((r) => r.id === "b")?.state).toBe("orphan");
    expect(rows.find((r) => r.id === "c")?.state).toBe("ended");
  });

  it("sorts active first, then orphans, then ended", () => {
    const events = [
      { type: "session_start", session_id: "ended", pid: 1, ts },
      { type: "session_end", session_id: "ended", ts },
      { type: "session_start", session_id: "orphan", pid: 2, ts },
      { type: "session_start", session_id: "active", pid: 3, ts },
    ];
    const rows = journalSessionRows(events, (pid) => pid === 3);
    expect(rows.map((r) => r.state)).toEqual(["active", "orphan", "ended"]);
  });

  it("marks id-less sessions as legacy and keeps the pid prefix in the id", () => {
    const events = [
      { type: "session_start", pid: 4242, ts },
      { type: "tool_call", pid: 4242, tool: "get_mcp_status", ok: true, ts },
    ];
    const rows = journalSessionRows(events, () => true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.legacy).toBe(true);
    expect(rows[0]?.id).toBe("pid:4242");
    expect(rows[0]?.state).toBe("active");
    expect(rows[0]?.toolCalls).toBe(1);
  });

  it("treats an ended legacy session as ended, not orphaned", () => {
    const events = [
      { type: "session_start", pid: 4242, ts },
      { type: "session_end", pid: 4242, ts },
    ];
    const rows = journalSessionRows(events, () => false);
    expect(rows[0]?.state).toBe("ended");
  });
});

describe("summarizeMcpJournal", () => {
  it("counts active sessions only when the owning process is alive", () => {
    const workspace = makeWorkspace([
      { type: "server_start", pid: 999, ts },
      { type: "session_start", session_id: "alive", pid: process.pid, ts },
      { type: "session_start", session_id: "dead", pid: 0, ts },
      { type: "session_start", session_id: "ended", pid: 555, ts },
      { type: "session_end", session_id: "ended", ts },
      { type: "tool_call", session_id: "alive", tool: "search_memories", ok: false, ts },
    ]);
    const s = summarizeMcpJournal(workspace);
    expect(s.sessions).toBe(3);
    expect(s.activeSessions).toBe(1);
    expect(s.toolCalls).toBe(1);
    expect(s.toolErrors).toBe(1);
    expect(s.lastTool).toBe("search_memories");
    expect(s.hasJournal).toBe(true);
  });

  it("counts legacy no-id sessions by liveness too", () => {
    const workspace = makeWorkspace([
      { type: "session_start", pid: process.pid, ts },
      { type: "session_start", pid: 0, ts },
    ]);
    const s = summarizeMcpJournal(workspace);
    expect(s.sessions).toBe(2);
    expect(s.activeSessions).toBe(1);
  });

  it("reports no journal for an empty workspace", () => {
    const workspace = makeWorkspace([]);
    const s = summarizeMcpJournal(workspace);
    expect(s.hasJournal).toBe(false);
    expect(s.sessions).toBe(0);
    expect(s.activeSessions).toBe(0);
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process and false for garbage pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(undefined)).toBe(false);
  });
});
