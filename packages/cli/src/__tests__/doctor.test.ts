import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only spawn (partial module mock) — execSync/execFile stay real for any
// sibling code imported through doctor.ts (e.g. setup.ts's commandExists).
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { runMcpSelfTest } from "../commands/doctor";

type SpawnMock = ReturnType<typeof vi.fn>;

interface FakeChild {
  child: unknown;
  handlers: Record<string, (arg?: unknown) => void>;
  stdout: EventEmitter;
  stdin: { write: SpawnMock; on: SpawnMock };
  kill: SpawnMock;
}

function createFakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stdin = { write: vi.fn(), on: vi.fn() };
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const child = {
    stdout,
    stdin,
    kill: vi.fn(),
    on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      handlers[event] = handler;
      return child;
    }),
  };
  return { child, handlers, stdout, stdin, kill: child.kill };
}

function installFake(): FakeChild {
  const fake = createFakeChild();
  vi.mocked(spawn).mockReturnValue(fake.child as unknown as ReturnType<typeof spawn>);
  return fake;
}

/** Emit a single JSON-RPC message (as one stdout chunk). */
function emitLine(stdout: EventEmitter, msg: unknown): void {
  stdout.emit("data", Buffer.from(`${JSON.stringify(msg)}\n`, "utf8"));
}

const INIT_RESULT = {
  jsonrpc: "2.0",
  id: 1,
  result: { serverInfo: { name: "astrivya-mcp-server", version: "1.2.3" } },
};

const TOOLS_RESULT = {
  jsonrpc: "2.0",
  id: 2,
  result: {
    tools: [{ name: "search_memories" }, { name: "log_memory" }, { name: "get_team_context" }],
  },
};

describe("runMcpSelfTest — handshake", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so per-test implementations like the
    // synchronous-throw one can't leak into later tests.
    vi.resetAllMocks();
  });

  it("completes initialize + tools/list and returns sorted tools", async () => {
    const fake = installFake();
    const promise = runMcpSelfTest(1_000);

    // The initialize request must be written synchronously on spawn.
    expect(fake.stdin.write).toHaveBeenCalled();
    const initWrite = String(fake.stdin.write.mock.calls[0]?.[0] ?? "");
    expect(initWrite).toContain('"method":"initialize"');
    expect(initWrite).toContain("astrivya-doctor");

    // Server replies: initialize, then tools/list.
    emitLine(fake.stdout, INIT_RESULT);
    emitLine(fake.stdout, TOOLS_RESULT);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.serverName).toBe("astrivya-mcp-server");
    expect(result.serverVersion).toBe("1.2.3");
    expect(result.tools).toEqual(["get_team_context", "log_memory", "search_memories"]);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("spawns with auto-index and update notifications disabled", async () => {
    const fake = installFake();
    const promise = runMcpSelfTest(1_000);

    // First arg is process.execPath under vitest (JS entry); loosen it so the
    // meaningful assertions (command + env flags) don't break if the runner's
    // argv[1] ever changes shape.
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["mcp-server"]),
      expect.objectContaining({
        env: expect.objectContaining({ ASTRIVYA_AUTO_INDEX: "off", NO_UPDATE_NOTIFIER: "1" }),
      }),
    );

    // Resolve the pending handshake so no timer is left dangling.
    emitLine(fake.stdout, INIT_RESULT);
    emitLine(fake.stdout, TOOLS_RESULT);
    await promise;
  });

  it("skips non-JSON output and handles a tools/list response split across chunks", async () => {
    const fake = installFake();
    const promise = runMcpSelfTest(1_000);

    // Raw non-JSON bytes (not a JSON-stringified value) to hit the parse-failure skip.
    fake.stdout.emit("data", Buffer.from("not json { garbage", "utf8"));
    emitLine(fake.stdout, INIT_RESULT);
    // Split the tools/list message across two chunks mid-line.
    const toolsJson = JSON.stringify(TOOLS_RESULT);
    const half = Math.floor(toolsJson.length / 2);
    fake.stdout.emit("data", Buffer.from(toolsJson.slice(0, half), "utf8"));
    fake.stdout.emit("data", Buffer.from(`${toolsJson.slice(half)}\n`, "utf8"));

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(3);
  });

  it("fails when initialize returns a JSON-RPC error", async () => {
    const fake = installFake();
    const promise = runMcpSelfTest(1_000);

    emitLine(fake.stdout, { jsonrpc: "2.0", id: 1, error: { message: "initialize rejected: nope" } });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("initialize rejected: nope");
    expect(result.tools).toEqual([]);
  });
});

describe("runMcpSelfTest — failure paths", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("fails when the child exits before the handshake completes", async () => {
    const fake = installFake();
    const promise = runMcpSelfTest(1_000);

    fake.handlers.exit?.(1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited early (code 1)");
  });

  it("fails when spawn emits an error (e.g. EACCES)", async () => {
    const fake = installFake();
    const promise = runMcpSelfTest(1_000);

    fake.handlers.error?.(new Error("EACCES: permission denied"));

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to start: EACCES");
  });

  it("fails when spawn throws synchronously", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("spawn boom");
    });

    const result = await runMcpSelfTest(1_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Could not spawn MCP server");
    expect(result.error).toContain("spawn boom");
  });

  it("times out when the server never responds", async () => {
    const fake = installFake();
    const started = Date.now();

    const result = await runMcpSelfTest(30);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(fake.kill).toHaveBeenCalled();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
