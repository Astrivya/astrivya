import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AkgStorage } from "@astrivya/akg-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildIdentityGraph } from "../identity";

const cleanups: string[] = [];

function tmpWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function git(root: string, args: string): void {
  execSync(`git ${args}`, { cwd: root, stdio: "ignore" });
}

async function openStorage(root: string): Promise<AkgStorage> {
  const storage = new AkgStorage();
  await storage.init(root);
  return storage;
}

afterEach(() => {
  while (cleanups.length > 0) fs.rmSync(cleanups.pop()!, { recursive: true, force: true });
});

describe("buildIdentityGraph", () => {
  it("builds the hierarchy for a real git workspace with a primary user", async () => {
    const ws = tmpWorkspace("akg-ident-git-");
    git(ws, "init");
    git(ws, 'config user.name "Ada Lovelace"');
    git(ws, 'config user.email "ada@example.com"');
    fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "pkg-a", dependencies: {} }));
    git(ws, "add -A");
    git(ws, 'commit -m "init"');

    const storage = await openStorage(ws);
    const result = buildIdentityGraph(storage, ws);
    storage.saveToDisk();

    expect(result.repos).toBe(1);
    expect(result.persons).toBe(1);
    expect(result.primaryUser).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });

    const repos = storage.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].metadata.packageName).toBe("pkg-a");
    expect(repos[0].metadata.branch).toBeTruthy();

    const persons = storage.listPersons();
    expect(persons.some((p) => p.isPrimary && p.email === "ada@example.com")).toBe(true);
    expect(persons.find((p) => p.isPrimary)?.role).toBe("owner");

    const edges = storage.runQuery("SELECT source, target, relation FROM edges;");
    expect(edges.some((e) => e.relation === "contains" && e.source === "workspace::root")).toBe(true);
    expect(edges.some((e) => e.relation === "works_in" && e.source.startsWith("person::"))).toBe(true);
    expect(edges.some((e) => e.relation === "contributes_to" && e.target.startsWith("repo::"))).toBe(true);
  });

  it("detects repos without git metadata (no contributors from a fake .git)", async () => {
    const ws = tmpWorkspace("akg-ident-fakegit-");
    fs.mkdirSync(path.join(ws, ".git"));
    fs.writeFileSync(path.join(ws, "main.ts"), "// x");

    const storage = await openStorage(ws);
    const result = buildIdentityGraph(storage, ws);

    expect(result.repos).toBe(1);
    expect(result.personEdges).toBe(0);
    // The machine's primary user is still resolved from global git config.
    expect(result.persons).toBe(result.primaryUser ? 1 : 0);
    expect(storage.listRepos()).toHaveLength(1);
    expect(storage.listRepos()[0].metadata.contributorCount).toBe(0);
  });

  it("creates a workspace node when nothing is a git repo (primary user still resolved)", async () => {
    const ws = tmpWorkspace("akg-ident-nogit-");
    fs.writeFileSync(path.join(ws, "notes.md"), "# notes");

    const storage = await openStorage(ws);
    const result = buildIdentityGraph(storage, ws);

    expect(result.repos).toBe(0);
    expect(result.personEdges).toBe(0);
    expect(result.persons).toBe(result.primaryUser ? 1 : 0);
    expect(storage.listRepos()).toHaveLength(0);
    expect(storage.getNode("workspace::root")).toBeTruthy();
  });

  it("links inter-repo dependencies by package name", async () => {
    const ws = tmpWorkspace("akg-ident-deps-");
    fs.mkdirSync(path.join(ws, "a", ".git"), { recursive: true });
    fs.mkdirSync(path.join(ws, "b", ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "a", "package.json"),
      JSON.stringify({ name: "pkg-a", dependencies: { "pkg-b": "1.0.0" } }),
    );
    fs.writeFileSync(path.join(ws, "b", "package.json"), JSON.stringify({ name: "pkg-b", dependencies: {} }));

    const storage = await openStorage(ws);
    const result = buildIdentityGraph(storage, ws);

    expect(result.repos).toBe(2);
    expect(result.repoEdges).toBeGreaterThanOrEqual(1);
    const edges = storage.runQuery("SELECT source, target, relation FROM edges WHERE relation = 'depends_on';");
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("repo::a");
    expect(edges[0].target).toBe("repo::b");
  });
});
