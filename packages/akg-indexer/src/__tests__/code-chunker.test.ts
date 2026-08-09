import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { describe, expect, it } from "vitest";
import { CodeChunker } from "../index";

describe("CodeChunker", () => {
  it("chunks code files into the local AKG with file/symbol nodes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-chunker-"));
    fs.writeFileSync(
      path.join(tmp, "app.ts"),
      `export function greet(name: string): string { return 'hi ' + name; }\nexport class Foo { constructor() {} bar() { return 1; } }\n`,
    );
    fs.writeFileSync(
      path.join(tmp, "README.md"),
      "# Hello\n\nIntro text about the project.\n\n## Setup\n\nSteps here.\n",
    );

    try {
      const storage = new AkgStorage();
      await storage.init(tmp);
      const chunker = new CodeChunker(storage, tmp);
      const out = await chunker.indexWorkspace();

      expect(out.files).toBe(2);
      expect(out.chunks).toBeGreaterThan(0);

      const stats = storage.getStats();
      expect(stats.chunks).toBe(out.chunks);
      expect(stats.nodes).toBeGreaterThanOrEqual(2);
      expect(stats.edges).toBeGreaterThanOrEqual(2);

      const symbols = storage.runQuery("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'symbol::%'");
      expect(Number(symbols[0].c)).toBeGreaterThanOrEqual(1);
      const headings = storage.runQuery("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'heading::%'");
      expect(Number(headings[0].c)).toBe(2);

      storage.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips unchanged files on a second run", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astica-chunker2-"));
    fs.writeFileSync(path.join(tmp, "lib.ts"), "export const x = 1;\n");

    try {
      const storage = new AkgStorage();
      await storage.init(tmp);
      const chunker = new CodeChunker(storage, tmp);
      const first = await chunker.indexWorkspace();
      const second = await chunker.indexWorkspace();

      expect(second.files).toBe(0);
      expect(first.chunks).toBeGreaterThan(0);
      storage.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
