#!/usr/bin/env node
/**
 * Aligns inter-package `@astrivya/*` dependency ranges to each package's own
 * (just-bumped) version.
 *
 * release-please bumps each package.json `version` field but leaves the
 * `@astrivya/*` ranges at the previous version (e.g. `^0.2.0` after a 0.3.0
 * bump), which makes `npm ci` fail with ERESOLVE. Run this on the release
 * branch before merging (see the "Prepare release branch" step in
 * .github/workflows/release.yml).
 *
 * Assumes the repo's linked-versions setup: every @astrivya package moves to
 * the same version, so each package's own version is the correct target for
 * all of its @astrivya deps.
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

let changed = 0;

for (const dir of PKG_DIRS) {
  const file = path.join(repoRoot, "packages", dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const target = `^${pkg.version}`;
  let dirty = false;

  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@astrivya/") && deps[name] !== target) {
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
