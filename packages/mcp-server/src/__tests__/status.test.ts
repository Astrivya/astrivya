import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getStatus,
  initStatus,
  journalPath,
  readJournal,
  recordServerStop,
  recordSessionEnd,
  recordSessionStart,
  recordToolCall,
} from "../status";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-status-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mcp-server status module", () => {
  it("records sessions and tool counters", () => {
    initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    recordSessionStart();
    recordSessionEnd();
    recordToolCall("search_memories", true);
    recordToolCall("log_decision", false);

    const s = getStatus();
    expect(s.version).toBe("1.0.0");
    expect(s.mode).toBe("stdio");
    expect(s.workspace).toBe(tmpDir);
    expect(s.sessions).toBe(1);
    expect(s.activeSessions).toBe(0);
    expect(s.toolCalls).toBe(2);
    expect(s.toolErrors).toBe(1);
    expect(s.tools).toEqual({ search_memories: 1, log_decision: 1 });
    expect(s.startedAt).toBeGreaterThan(0);
    expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("writes and reads the workspace journal", () => {
    initStatus({ workspace: tmpDir, mode: "http", version: "1.0.0" });
    recordSessionStart();
    recordToolCall("get_person_context", true);
    recordServerStop("SIGINT");

    const file = journalPath(tmpDir);
    expect(fs.existsSync(file)).toBe(true);

    const events = readJournal(tmpDir, 100);
    expect(events.length).toBe(4);
    expect(events[0].type).toBe("server_start");
    expect(events[1].type).toBe("session_start");
    expect(events[2].type).toBe("tool_call");
    expect(events[2].tool).toBe("get_person_context");
    expect(events[2].ok).toBe(true);

    const last = readJournal(tmpDir, 1)[0];
    expect(last.type).toBe("server_stop");
  });

  it("returns an empty journal for unknown workspaces", () => {
    initStatus({ workspace: tmpDir, mode: "stdio", version: "1.0.0" });
    expect(readJournal(path.join(tmpDir, "nope"), 10)).toEqual([]);
  });
});
