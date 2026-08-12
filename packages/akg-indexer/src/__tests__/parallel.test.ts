import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { describe, expect, it } from "vitest";
import { computeNextWorkerCount, resolveWorkerPath } from "../index";

describe("computeNextWorkerCount", () => {
  const base = { min: 2, max: 8, rateNow: 100, ratePrev: 100, windowElapsedMs: 2000 };

  it("never exceeds max", () => {
    expect(computeNextWorkerCount({ ...base, current: 8 })).toBe(8);
  });

  it("never drops below min", () => {
    expect(computeNextWorkerCount({ ...base, current: 2, rateNow: 10 })).toBe(2);
  });

  it("ramps up while per-worker throughput stays within 5%", () => {
    expect(computeNextWorkerCount({ ...base, current: 2, rateNow: 200 })).toBe(3);
  });

  it("scales down one at a time on >30% per-worker collapse", () => {
    expect(computeNextWorkerCount({ ...base, current: 4, rateNow: 60 })).toBe(3);
  });

  it("holds steady when degradation is within tolerance", () => {
    expect(computeNextWorkerCount({ ...base, current: 4, rateNow: 96 })).toBe(4);
  });

  it("ignores windows shorter than 1s", () => {
    expect(computeNextWorkerCount({ ...base, current: 2, windowElapsedMs: 500 })).toBe(2);
  });

  it("scales up on the first real window", () => {
    expect(computeNextWorkerCount({ ...base, current: 2, ratePrev: 0 })).toBe(3);
  });
});

describe("parallel indexing", () => {
  const buildFixture = (root: string): void => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.mkdirSync(path.join(root, "adr"), { recursive: true });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(root, "src", `mod${i}.ts`),
        `export function fn${i}(): number { return ${i}; }\nexport const val${i} = ${i};\n`,
      );
    }
    fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nSome docs here.\n\n## Install\n\nSteps.\n");
    fs.writeFileSync(
      path.join(root, "adr", "0001-use-rest.md"),
      "# ADR 1\n\n## Status\nAccepted\n\n## Decision\nUse REST over GraphQL.\n",
    );
  };

  it("indexes every unit and merges into one database", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-par-"));
    buildFixture(tmp);
    try {
      const { AkgIndexer } = await import("../index");
      const storage = new AkgStorage();
      await storage.init(tmp);
      const indexer = new AkgIndexer(storage, tmp);
      const result = await indexer.indexWorkspaceDetailed(() => {}, { parallel: true });

      expect(result.workersUsed).toBeGreaterThan(0);
      expect(result.filesIndexed).toBe(8);
      expect(result.chunks).toBeGreaterThan(0);
      expect(result.failed).toBe(0);
      expect(result.units.length).toBeGreaterThanOrEqual(3);

      const stats = storage.getStats();
      expect(stats.nodes).toBeGreaterThanOrEqual(8);
      expect(stats.edges).toBeGreaterThan(0);
      storage.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parallel and serial produce identical content", async () => {
    const { AkgIndexer } = await import("../index");
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "akg-para-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "akg-serial-"));
    buildFixture(tmpA);
    buildFixture(tmpB);
    try {
      const storageA = new AkgStorage();
      await storageA.init(tmpA);
      const par = await new AkgIndexer(storageA, tmpA).indexWorkspaceDetailed(() => {}, {
        parallel: true,
      });

      const storageB = new AkgStorage();
      await storageB.init(tmpB);
      const ser = await new AkgIndexer(storageB, tmpB).indexWorkspaceDetailed(() => {}, {
        parallel: false,
      });

      expect(par.filesIndexed).toBe(ser.filesIndexed);
      expect(par.chunks).toBe(ser.chunks);
      expect(par.workersUsed).toBeGreaterThan(0);
      expect(ser.workersUsed).toBe(0);

      const filesA = storageA
        .runQuery("SELECT id, label, content FROM nodes WHERE type = 'file' ORDER BY id")
        .map((r: any) => `${r.id}|${r.label}|${r.content ?? ""}`);
      const filesB = storageB
        .runQuery("SELECT id, label, content FROM nodes WHERE type = 'file' ORDER BY id")
        .map((r: any) => `${r.id}|${r.label}|${r.content ?? ""}`);
      expect(filesA).toEqual(filesB);

      const chunksA = storageA
        .runQuery("SELECT id, content FROM chunks ORDER BY id")
        .map((r: any) => `${r.id}|${r.content}`);
      const chunksB = storageB
        .runQuery("SELECT id, content FROM chunks ORDER BY id")
        .map((r: any) => `${r.id}|${r.content}`);
      expect(chunksA).toEqual(chunksB);

      storageA.close();
      storageB.close();
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });

  it("resolveWorkerPath finds the bundled worker entry", () => {
    const p = resolveWorkerPath();
    expect(p).not.toBeNull();
    expect(fs.existsSync(p!)).toBe(true);
  });
});
