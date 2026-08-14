import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AkgStorage } from "@astrivya/akg-core";
import { scanWorkspace } from "./workspace-map";

/**
 * Identity layer for the AKG: models the hierarchy
 *
 *   primary user (owner)  →  workspace  →  repos  →  contributors/members
 *
 * plus inter-repo relations (cross-package dependencies). It is a pure
 * augmentation pass over already-indexed units: it never touches chunks or
 * embeddings. All git calls are best-effort and fail silently (a workspace
 * without git still gets a workspace + primary user node).
 */

export interface RepoIdentity {
  relPath: string;
  label: string;
  remoteUrl: string | null;
  branch: string | null;
  contributors: { name: string; email: string; commits: number }[];
  packageName: string | null;
  dependencies: string[];
}

export interface IdentityBuildResult {
  repos: number;
  persons: number;
  repoEdges: number;
  personEdges: number;
  primaryUser: { name: string; email: string } | null;
}

function gitExec(cwd: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    }).trim();
  } catch {
    return null;
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function normRel(root: string, p: string): string {
  return path.relative(root, p).replace(/\\/g, "/") || ".";
}

function readRepoIdentity(root: string, relPath: string): RepoIdentity {
  const abs = path.join(root, relPath);
  const remoteUrl = gitExec(abs, "config --get remote.origin.url");
  const branch = gitExec(abs, "rev-parse --abbrev-ref HEAD");
  const contributors: { name: string; email: string; commits: number }[] = [];

  const log = gitExec(abs, 'log --format="%an|%ae" -n 2000');
  if (log) {
    const counts = new Map<string, { name: string; email: string; commits: number }>();
    for (const line of log.split("\n")) {
      const [name, email] = line.split("|");
      const key = email || name || "";
      if (!key) continue;
      const cur = counts.get(key) ?? { name: name || key, email: email || "", commits: 0 };
      cur.commits++;
      counts.set(key, cur);
    }
    contributors.push(...counts.values());
    contributors.sort((a, b) => b.commits - a.commits);
  }

  let packageName: string | null = null;
  const dependencies: string[] = [];
  const pkg = readJson(path.join(abs, "package.json"));
  if (pkg) {
    packageName = typeof pkg.name === "string" ? pkg.name : null;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    dependencies.push(...Object.keys(deps));
  }

  return { relPath, label: path.basename(abs), remoteUrl, branch, contributors, packageName, dependencies };
}

function primaryUser(root: string): { name: string; email: string } | null {
  const name = gitExec(root, "config user.name");
  const email = gitExec(root, "config user.email");
  if (!name && !email) return null;
  const resolved = { name: name ?? "", email: email ?? "" };
  if (!resolved.name && resolved.email) resolved.name = resolved.email.split("@")[0] || resolved.email;
  return resolved;
}

/**
 * Build (or refresh) the identity hierarchy in the workspace graph.
 *
 * Creates:
 *   - `workspace::root` node (upserted metadata)
 *   - one `repo::<relPath>` node per git repo, with remote/branch/package metadata
 *   - one `person::<email>` node per contributor, role owner for the primary user
 *   - `contributes_to` edges person → repo / person → workspace (weight = commits)
 *   - `works_in` edge primary user → workspace
 *   - `depends_on` edges between repos for cross-package dependencies
 */
export function buildIdentityGraph(storage: AkgStorage, workspaceRoot: string): IdentityBuildResult {
  const now = Date.now();
  const result: IdentityBuildResult = { repos: 0, persons: 0, repoEdges: 0, personEdges: 0, primaryUser: null };

  const map = scanWorkspace(workspaceRoot);
  const repoUnits = map.units.filter((u) => u.kind === "git-repo");
  const workspaceId = "workspace::root";

  // 1. Workspace node (always exists).
  storage.upsertNode({
    id: workspaceId,
    label: path.basename(workspaceRoot) || workspaceRoot,
    type: "workspace",
    metadata: JSON.stringify({
      path: workspaceRoot,
      rootIsRepo: map.rootIsRepo,
      repos: repoUnits.length,
      updatedAt: now,
    }),
    createdAt: now,
    updatedAt: now,
  });

  // 2. Repo identities.
  const identities = repoUnits.map((u) => readRepoIdentity(workspaceRoot, normRel(workspaceRoot, u.path)));
  const pkgToRepo = new Map<string, string>();
  for (const idn of identities) {
    const repoId = `repo::${idn.relPath === "." ? path.basename(workspaceRoot) : idn.relPath}`;
    storage.upsertNode({
      id: repoId,
      label: idn.label,
      type: "repo",
      metadata: JSON.stringify({
        relPath: idn.relPath,
        remoteUrl: idn.remoteUrl,
        branch: idn.branch,
        packageName: idn.packageName,
        contributorCount: idn.contributors.length,
      }),
      createdAt: now,
      updatedAt: now,
    });
    storage.addEdge({ source: workspaceId, target: repoId, relation: "contains", weight: 1 });
    result.repos++;
    if (idn.packageName) pkgToRepo.set(idn.packageName, repoId);
  }

  // 3. Primary user (owner).
  const user = primaryUser(workspaceRoot);
  if (user) {
    const userId = `person::${user.email || user.name}`;
    storage.addPerson({ id: userId, name: user.name, email: user.email || undefined, role: "owner", isPrimary: true });
    storage.addEdge({ source: userId, target: workspaceId, relation: "works_in", weight: 1 });
    storage.addEdge({ source: userId, target: workspaceId, relation: "contributes_to", weight: 1 });
    result.persons++;
    result.primaryUser = user;
  }

  // 4. Contributors → repos and workspace.
  const seen = new Set<string>();
  if (user) seen.add(`person::${user.email || user.name}`);
  for (const idn of identities) {
    const repoId = `repo::${idn.relPath === "." ? path.basename(workspaceRoot) : idn.relPath}`;
    for (const c of idn.contributors) {
      const personId = `person::${c.email || c.name}`;
      if (!seen.has(personId)) {
        storage.addPerson({
          id: personId,
          name: c.name,
          email: c.email || undefined,
          role: personId === (user ? `person::${user.email || user.name}` : "") ? "owner" : "contributor",
          isPrimary: personId === (user ? `person::${user.email || user.name}` : ""),
        });
        seen.add(personId);
        result.persons++;
      }
      storage.addEdge({ source: personId, target: repoId, relation: "contributes_to", weight: c.commits });
      result.personEdges++;
    }
  }

  // 5. Inter-repo dependency edges (package-name resolution).
  for (const idn of identities) {
    if (!idn.packageName) continue;
    const srcRepo = pkgToRepo.get(idn.packageName);
    if (!srcRepo) continue;
    for (const dep of idn.dependencies) {
      const tgtRepo = pkgToRepo.get(dep);
      if (tgtRepo && tgtRepo !== srcRepo) {
        storage.addEdge({ source: srcRepo, target: tgtRepo, relation: "depends_on", weight: 1 });
        result.repoEdges++;
      }
    }
  }

  return result;
}
