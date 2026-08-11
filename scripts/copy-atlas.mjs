#!/usr/bin/env node
/**
 * Copy the built Atlas web app into the CLI dist so `astrivya serve` can
 * serve the visualizer from an installed CLI package.
 *
 * Usage: node scripts/copy-atlas.mjs
 * - Reads packages/atlas/dist (vite build output).
 * - Copies it to packages/cli/dist/atlas.
 * - Skips gracefully (exit 0) when the atlas build is missing, so the CLI
 *   build never fails because the private atlas app wasn't built.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const atlasDist = path.join(root, "packages", "atlas", "dist");
const cliDist = path.join(root, "packages", "cli", "dist", "atlas");

if (!fs.existsSync(atlasDist)) {
  console.warn("[copy-atlas] packages/atlas/dist not found — skipping (run `npm run build:atlas` first)");
  process.exit(0);
}

fs.rmSync(cliDist, { recursive: true, force: true });
fs.cpSync(atlasDist, cliDist, { recursive: true });
console.log(`[copy-atlas] copied ${atlasDist} -> ${cliDist}`);