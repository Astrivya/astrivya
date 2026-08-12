import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { describe, expect, it } from "vitest";
import { CodeChunker } from "../code-chunker";
import { countIndexableFiles, detectMarkers, isGitRepo, scanWorkspace, summarizeUnits } from "../workspace-map";

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

describe("scanWorkspace", () => {
  it("treats a root git repo as a single unit", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-map-root-repo-"));
    mkdir(path.join(tmp, ".git"));
    fs.writeFileSync(path.join(tmp, "app.ts"), "// x");
    fs.writeFileSync(path.join(tmp, "README.md"), "# hi");
    mkdir(path.join(tmp, "node_modules", "dep"));
    fs.writeFileSync(path.join(tmp, "node_modules", "dep", "index.js"), "// dep");

    const map = scanWorkspace(tmp);
    expect(map.rootIsRepo).toBe(true);
    expect(map.units).toHaveLength(1);
    expect(map.units[0].kind).toBe("git-repo");
    expect(map.units[0].fileCount).toBe(2);
    expect(map.totalFiles).toBe(2);
    expect(map.skippedTopLevel).toEqual([".git", "node_modules"]);
  });

  it("identifies git repos, folders and loose root files in a multi-repo workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-map-multi-"));
    mkdir(path.join(tmp, "repoA", ".git"));
    fs.writeFileSync(path.join(tmp, "repoA", "a.ts"), "// a");
    mkdir(path.join(tmp, "repoB", ".git"));
    fs.writeFileSync(path.join(tmp, "repoB", "b.ts"), "// b");
    mkdir(path.join(tmp, "plain"));
    fs.writeFileSync(path.join(tmp, "plain", "p.md"), "# p");
    fs.writeFileSync(path.join(tmp, "notes.md"), "# notes");

    const map = scanWorkspace(tmp);
    expect(map.rootIsRepo).toBe(false);
    const kinds = map.units.map((u) => u.kind);
    expect(kinds).toContain("git-repo");
    expect(kinds).toContain("folder");
    expect(kinds).toContain("loose");

    const loose = map.units.find((u) => u.kind === "loose")!;
    expect(loose.name).toBe("(workspace root)");
    expect(loose.fileCount).toBe(1); // notes.md only

    const repoA = map.units.find((u) => u.name === "repoA")!;
    expect(repoA.kind).toBe("git-repo");
    expect(repoA.fileCount).toBe(1);
    expect(repoA.markers).toContain(".git");

    const plain = map.units.find((u) => u.name === "plain")!;
    expect(plain.kind).toBe("folder");
    expect(plain.fileCount).toBe(1);

    const summary = summarizeUnits(map.units);
    expect(summary.repos).toBe(2);
    expect(summary.folders).toBe(1);
    expect(summary.files).toBe(4);
  });

  it("lifts nested git repos into their own units and excludes them from the parent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-map-nested-"));
    mkdir(path.join(tmp, "mono", "apps", "svcA", ".git"));
    fs.writeFileSync(path.join(tmp, "mono", "apps", "svcA", "x.ts"), "// x");
    mkdir(path.join(tmp, "mono", "apps", "svcB", ".git"));
    fs.writeFileSync(path.join(tmp, "mono", "apps", "svcB", "y.ts"), "// y");
    mkdir(path.join(tmp, "mono", "shared"));
    fs.writeFileSync(path.join(tmp, "mono", "shared", "u.ts"), "// u");

    const map = scanWorkspace(tmp);
    const mono = map.units.find((u) => u.name === "mono")!;
    expect(mono.kind).toBe("workspace-root");
    expect(mono.nestedRepos).toEqual(["apps/svcA", "apps/svcB"]);
    // nested repo files excluded from the parent's count
    expect(mono.fileCount).toBe(1); // shared/u.ts

    const svcA = map.units.find((u) => u.name === "mono/apps/svcA")!;
    expect(svcA).toBeDefined();
    expect(svcA.kind).toBe("git-repo");
    expect(svcA.fileCount).toBe(1);

    const svcB = map.units.find((u) => u.name === "mono/apps/svcB")!;
    expect(svcB).toBeDefined();
    expect(svcB.fileCount).toBe(1);

    expect(map.totalFiles).toBe(3);
  });

  it("detects a submodule-style .git file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-map-submodule-"));
    mkdir(path.join(tmp, "sub"));
    fs.writeFileSync(path.join(tmp, "sub", ".git"), "gitdir: ../.git/modules/sub");
    expect(isGitRepo(path.join(tmp, "sub"))).toBe(true);
    expect(detectMarkers(path.join(tmp, "sub"))).toContain(".git");
    fs.writeFileSync(path.join(tmp, "sub", "mod.ts"), "// m");
    const map = scanWorkspace(tmp);
    const sub = map.units.find((u) => u.name === "sub")!;
    expect(sub).toBeDefined();
    expect(sub.kind).toBe("git-repo");
    expect(sub.fileCount).toBe(1);
  });

  it("reports empty git repos as units with 0 files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-map-empty-"));
    mkdir(path.join(tmp, "empty-repo", ".git"));
    const map = scanWorkspace(tmp);
    const empty = map.units.find((u) => u.name === "empty-repo")!;
    expect(empty).toBeDefined();
    expect(empty.kind).toBe("git-repo");
    expect(empty.fileCount).toBe(0);
  });

  it("classifies a folder with package.json workspaces as a workspace root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-map-workspaces-"));
    mkdir(path.join(tmp, "monorepo"));
    fs.writeFileSync(
      path.join(tmp, "monorepo", "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    const map = scanWorkspace(tmp);
    const mono = map.units.find((u) => u.name === "monorepo")!;
    expect(mono.kind).toBe("workspace-root");
    expect(detectMarkers(path.join(tmp, "monorepo"))).toContain("package.json#workspaces");
  });

  it("counts only indexable files (skips lockfiles, binaries, images)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-map-count-"));
    fs.writeFileSync(path.join(tmp, "a.ts"), "// a");
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(tmp, "photo.png"), "\x00\x01");
    fs.writeFileSync(path.join(tmp, "yarn.lock"), "");
    fs.writeFileSync(path.join(tmp, "b.md"), "# b");
    fs.writeFileSync(path.join(tmp, "c.js.map"), "{}");
    mkdir(path.join(tmp, "dist"));
    fs.writeFileSync(path.join(tmp, "dist", "d.js"), "// d");

    expect(countIndexableFiles(tmp)).toBe(2);
  });
});

describe("CodeChunker.indexUnits", () => {
  it("indexes nested git repos exactly once (no double-walk), with workspace-relative ids", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akg-units-walk-"));
    mkdir(path.join(tmp, "mono", "apps", "svcA", ".git"));
    fs.writeFileSync(path.join(tmp, "mono", "apps", "svcA", "x.ts"), "export const x = 1;\n");
    mkdir(path.join(tmp, "mono", "shared"));
    fs.writeFileSync(path.join(tmp, "mono", "shared", "u.ts"), "export const u = 2;\n");

    const map = scanWorkspace(tmp);
    const storage = new AkgStorage();
    await storage.init(tmp);
    try {
      const chunker = new CodeChunker(storage, tmp);
      const events: string[] = [];
      const res = await chunker.indexUnits(map.units, {
        saveToDisk: false,
        onEvent: (ev) => {
          if (ev.file) events.push(ev.file);
        },
      });

      expect(events.sort()).toEqual(["mono/apps/svcA/x.ts", "mono/shared/u.ts"]);
      expect(res.files).toBe(2);

      const rows = storage.runQuery("SELECT id FROM nodes WHERE id LIKE 'file::%' ORDER BY id");
      expect(rows.map((r: any) => r.id).sort()).toEqual(["file::mono/apps/svcA/x.ts", "file::mono/shared/u.ts"]);
    } finally {
      storage.close();
    }
  });
});
