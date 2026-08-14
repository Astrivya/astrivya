import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../index";
import { getClientInfo, initStatus } from "../status";

describe("MCP initialize handshake (Agent Mesh identity layer 1)", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-init-"));
    initStatus({ workspace: dir, mode: "stdio", version: "test" });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("captures clientInfo (name + version) from the client handshake", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "opencode", version: "0.5.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const info = getClientInfo(`stdio:${process.pid}`);
    expect(info.client).toBe("opencode");
    expect(info.version).toBe("0.5.0");

    await client.close();
  });

  it("negotiates the protocol version and lists the mesh tools", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("identify_agent");
    expect(names).toContain("agent_message");
    expect(names).toContain("mesh_read");
    expect(names).toContain("search_memories");

    const info = getClientInfo(`stdio:${process.pid}`);
    expect(info.client).toBe("claude-code");

    await client.close();
  });
});
