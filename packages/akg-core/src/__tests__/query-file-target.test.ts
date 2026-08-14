import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AkgQuery } from "../akg-query";
import { AkgStorage } from "../akg-storage";
import { cleanupTempWorkspace, createTempWorkspace } from "./helpers";

function chunk(id: string, filePath: string, content: string) {
  const now = Date.now();
  return { id, nodeId: `file::${path.basename(filePath)}`, filePath, content, createdAt: now, updatedAt: now };
}

describe("AkgQuery file-target search", () => {
  let storage: AkgStorage;
  let ws: string;

  beforeEach(async () => {
    ws = createTempWorkspace();
    storage = new AkgStorage();
    await storage.init(ws);
  });

  afterEach(() => {
    cleanupTempWorkspace(ws);
  });

  it("surfaces a chunk from a file whose name matches the query", async () => {
    storage.upsertChunk(
      chunk("c1", "src/optimizer.ts", "This function rearranges the internal buffer layout before the final pass."),
    );
    storage.upsertChunk(chunk("c2", "src/unrelated.ts", "Completely different content about parsing directives."));

    const q = new AkgQuery(storage, ws);
    const results = await q.retrieve("optimization", 5);

    const hit = results.find((r) => r.source === "file");
    expect(hit).toBeTruthy();
    expect(hit?.filePath).toBe("src/optimizer.ts");
    expect(hit?.content).toContain("buffer layout");
  });

  it("matches with light stemming (plural / -ize forms)", async () => {
    storage.upsertChunk(chunk("c1", "src/optimizer.ts", "This function rearranges the internal buffer layout."));

    const q = new AkgQuery(storage, ws);
    const results = await q.retrieve("optimizations", 5);

    expect(results.some((r) => r.source === "file" && r.filePath === "src/optimizer.ts")).toBe(true);
  });

  it("returns no file-target results for a query naming no file", async () => {
    storage.upsertChunk(chunk("c1", "src/optimizer.ts", "This function rearranges the internal buffer layout."));

    const q = new AkgQuery(storage, ws);
    const results = await q.retrieve("quantum entanglement", 5);

    expect(results.some((r) => r.source === "file")).toBe(false);
  });

  it("fuses the lexical hit and the filename hit into one entry, lexical source wins", async () => {
    storage.upsertChunk(chunk("c1", "src/optimizer.ts", "The optimizer sweeps the buffer to compact it."));
    storage.upsertChunk(chunk("c2", "src/parser.ts", "Unrelated parsing logic with no match here."));

    const q = new AkgQuery(storage, ws);
    const results = await q.retrieve("optimizer", 5);

    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe("c1");
    // Same chunk matched by both strategies; fusion keeps one entry and the
    // dominant lexical signal wins the source label.
    expect(results[0].source).toBe("fts");
  });
});
