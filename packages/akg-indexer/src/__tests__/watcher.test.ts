import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Watcher } from "../watcher";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "akg-watch-"));
  tmpDirs.push(dir);
  return dir;
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

describe("Watcher", () => {
  it("delivers debounced batches of changed file paths", async () => {
    const root = makeRoot();
    const seen: string[][] = [];
    const watcher = new Watcher(
      (files) => {
        seen.push(files);
      },
      { debounceMs: 60 },
    );
    expect(watcher.start(root)).toBe(true);

    writeFileSync(join(root, "a.ts"), "1");
    writeFileSync(join(root, "b.ts"), "2");

    const ok = await waitFor(() => seen.length === 1);
    watcher.stop();
    expect(ok).toBe(true);
    expect(seen[0]?.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.map((f) => f.replace(/\\/g, "/"))).toContain(join(root, "a.ts").replace(/\\/g, "/"));
  });

  it("filters hidden dirs, ignored dirs, ignored extensions and non-files", async () => {
    const root = makeRoot();
    const seen: string[][] = [];
    const watcher = new Watcher(
      (files) => {
        seen.push(files);
      },
      { debounceMs: 50 },
    );
    expect(watcher.start(root)).toBe(true);

    writeFileSync(join(root, "keep.ts"), "1");
    writeFileSync(join(root, "skip.json"), "1");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x.ts"), "1");

    const ok = await waitFor(() => seen.length === 1);
    watcher.stop();
    expect(ok).toBe(true);
    expect(seen[0]?.length).toBe(1);
    expect(seen[0]?.[0]?.endsWith("keep.ts")).toBe(true);
  });

  it("returns false when the root does not exist (no throw)", () => {
    const watcher = new Watcher(() => {});
    expect(watcher.start(join(tmpdir(), "does-not-exist-akg-watch-test"))).toBe(false);
  });

  it("stop() is idempotent and safe after close", () => {
    const watcher = new Watcher(() => {});
    watcher.stop();
    watcher.stop();
    expect(watcher.start(makeRoot())).toBe(true);
    watcher.stop();
  });
});
