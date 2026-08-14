#!/usr/bin/env node
/**
 * Aligns inter-package `@astrivya/*` dependency ranges to the actual version
 * of each dependency on this branch.
 *
 * release-please bumps each released package.json `version` field but leaves
 * the `@astrivya/*` ranges at the previous version (e.g. `^0.2.0` after a
 * 0.3.0 bump), which makes `npm ci` fail with ERESOLVE. It also skips
 * components with no commits since their last tag (linked-versions only
 * forces a shared version on components that have releases), so a group
 * release can legitimately mix versions (e.g. akg-core@0.4.0 +
 * plugin-api@0.5.0). Aligning each range to the dependency's actual version
 * keeps `npm ci` resolvable in both cases.
 *
 * Run this on the release branch before merging (see the "Prepare release
 * branch" step in .github/workflows/release.yml).
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// The released workspace packages (must stay in sync with
// .github/release-please-config.json "linked-versions").
const PKG_DIRS = ["akg-core", "akg-indexer", "mcp-server", "cli", "plugin-api", "plugin-runtime"];
const SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

// Resolve each group package's actual version on this branch.
const versions = {};
for (const dir of PKG_DIRS) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "packages", dir, "package.json"), "utf8"));
  versions[`@astrivya/${dir}`] = pkg.version;
}

let changed = 0;

for (const dir of PKG_DIRS) {
  const file = path.join(repoRoot, "packages", dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  let dirty = false;

  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith("@astrivya/")) continue;
      const actual = versions[name];
      if (!actual) {
        console.warn(`[align] ${dir}: unknown package ${name}, leaving ${deps[name]} unchanged`);
        continue;
      }
      const target = `^${actual}`;
      if (deps[name] !== target) {
        console.log(`[align] ${dir}: ${name} ${deps[name]} -> ${target}`);
        deps[name] = target;
        dirty = true;
      }
    }
  }

  if (dirty) {
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    changed++;
  }
}

if (changed === 0) {
  console.log("[align] all @astrivya ranges already aligned");
} else {
  console.log(`[align] updated ${changed} package.json(s)`);
}