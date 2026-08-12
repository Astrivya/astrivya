import * as fs from "node:fs";
import * as path from "node:path";
import { SKIP_DIRS, isIndexableFileName } from "./code-chunker";
import type { WorkspaceMap, WorkspaceUnit, WorkspaceUnitKind } from "./types";

/**
 * Marker files that strongly indicate a multi-package workspace root.
 * `package.json` is checked separately for a `workspaces` field.
 */
const STRONG_WORKSPACE_MARKERS = new Set([
  "pnpm-workspace.yaml",
  "lerna.json",
  "turbo.json",
  "turborepo.json",
  "nx.json",
  "rush.json",
  "go.work",
  ".gitmodules",
  "workspace.json",
  "workspaces.json",
]);

/**
 * Marker files that identify a project root (single package / crate / app).
 * On their own they classify a folder as plain; combined with strong markers
 * or nested git repos they contribute to "workspace-root".
 */
const PROJECT_MARKERS = new Set([
  "package.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.toml",
  "pyproject.toml",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "flake.nix",
  "uv.lock",
  "Gemfile",
  "go.mod",
  "README.md",
]);

/** Check whether a directory is a git repo (`.git` can be a dir or a file, e.g. submodules/worktrees). */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/** Detect marker files (and workspace semantics) present in a directory. */
export function detectMarkers(dir: string): string[] {
  const markers: string[] = [];
  if (isGitRepo(dir)) markers.push(".git");
  for (const m of STRONG_WORKSPACE_MARKERS) {
    if (fs.existsSync(path.join(dir, m))) markers.push(m);
  }
  for (const m of PROJECT_MARKERS) {
    if (fs.existsSync(path.join(dir, m))) markers.push(m);
  }
  const pkgFile = path.join(dir, "package.json");
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8")) as { workspaces?: unknown };
      if (pkg.workspaces) markers.push("package.json#workspaces");
    } catch {
      // unreadable/invalid package.json - ignore
    }
  }
  return markers;
}

/** Count indexable files under a directory, optionally excluding absolute subpaths (nested repos). */
export function countIndexableFiles(dir: string, excludePaths: Set<string> = new Set()): number {
  let count = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (excludePaths.has(full)) continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && isIndexableFileName(entry.name)) count++;
    }
  };
  walk(dir);
  return count;
}

/** Names (relative, forward-slash) of git repos nested inside a directory, up to 2 levels deep. */
function findNestedRepos(dir: string): string[] {
  const nested: string[] = [];
  const scan = (d: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (isGitRepo(full)) {
        nested.push(normRelPath(path.relative(dir, full)));
        continue;
      }
      scan(full, depth + 1);
    }
  };
  scan(dir, 1);
  return [...new Set(nested)].sort((a, b) => a.localeCompare(b));
}

/** Count indexable files directly at the root level (not inside subdirectories). */
function countLooseRootFiles(root: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (isIndexableFileName(entry.name)) count++;
  }
  return count;
}

function classifyUnit(dir: string, markers: string[], nestedRepos: string[]): WorkspaceUnitKind {
  if (markers.includes(".git")) return "git-repo";
  if (nestedRepos.length > 0) return "workspace-root";
  if (markers.some((m) => STRONG_WORKSPACE_MARKERS.has(m) || m === "package.json#workspaces")) {
    return "workspace-root";
  }
  return "folder";
}

/** Normalize a relative path to forward slashes. */
function normRelPath(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/**
 * Scan a workspace and identify its indexable units: git repos, workspace
 * roots (monorepos), plain folders, and loose root files. Git repos nested
 * one level inside a top-level folder are lifted into their own units so each
 * repo is indexed (and shown) separately.
 *
 * Edge cases handled:
 * - Root is a git repo -> single unit covering everything (no splitting).
 * - Submodules/worktrees: `.git` as a file is still detected.
 * - Top-level skip dirs (node_modules, dist, ...) are reported separately.
 * - Permission-denied / unreadable dirs are counted as empty.
 * - Empty git repos are reported as units with 0 files.
 */
export function scanWorkspace(root: string): WorkspaceMap {
  const skippedTopLevel: string[] = [];
  const units: WorkspaceUnit[] = [];
  let totalFiles = 0;

  const rootIsRepo = isGitRepo(root);
  if (rootIsRepo) {
    const markers = detectMarkers(root);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) skippedTopLevel.push(entry.name);
    }
    skippedTopLevel.sort((a, b) => a.localeCompare(b));
    units.push({
      name: path.basename(root) || root,
      path: root,
      kind: "git-repo",
      markers,
      fileCount: countIndexableFiles(root),
      nestedRepos: [],
    });
  } else {
    const looseCount = countLooseRootFiles(root);
    if (looseCount > 0) {
      units.push({
        name: "(workspace root)",
        path: root,
        kind: "loose",
        markers: detectMarkers(root),
        fileCount: looseCount,
        nestedRepos: [],
      });
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) {
        skippedTopLevel.push(entry.name);
        continue;
      }
      const dir = path.join(root, entry.name);
      const markers = detectMarkers(dir);
      const nestedRepos = findNestedRepos(dir);
      const kind = classifyUnit(dir, markers, nestedRepos);

      // Nested repos are excluded from the parent's file count/walk and are
      // indexed as their own units (each repo gets its own progress row).
      const exclude = new Set(nestedRepos.map((n) => path.join(dir, n)));
      units.push({
        name: entry.name,
        path: dir,
        kind,
        markers,
        fileCount: countIndexableFiles(dir, exclude),
        nestedRepos,
      });
      for (const repoName of nestedRepos) {
        const repoPath = path.join(dir, repoName);
        units.push({
          name: `${entry.name}/${repoName}`,
          path: repoPath,
          kind: "git-repo",
          markers: detectMarkers(repoPath),
          fileCount: countIndexableFiles(repoPath),
          nestedRepos: [],
        });
      }
    }
  }

  totalFiles = units.reduce((acc, u) => acc + u.fileCount, 0);
  return { root, rootIsRepo, units, totalFiles, skippedTopLevel };
}

/** Human-readable summary of a workspace map (used by CLI/MCP output). */
export function summarizeUnits(units: WorkspaceUnit[]): {
  repos: number;
  workspaces: number;
  folders: number;
  loose: number;
  files: number;
} {
  let repos = 0;
  let workspaces = 0;
  let folders = 0;
  let loose = 0;
  let files = 0;
  for (const u of units) {
    if (u.kind === "git-repo") repos++;
    else if (u.kind === "workspace-root") workspaces++;
    else if (u.kind === "folder") folders++;
    else loose++;
    files += u.fileCount;
  }
  return { repos, workspaces, folders, loose, files };
}

export const WORKSPACE_MARKER_FILES = STRONG_WORKSPACE_MARKERS;
