import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "workers/index-worker": "../akg-indexer/src/workers/index-worker.ts",
  },
  format: "cjs",
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
  bundle: true,
  treeshake: true,
  sourcemap: "external",
  define: {
    "process.env.__PACKAGE_VERSION__": JSON.stringify(version),
  },
  external: [
    "@modelcontextprotocol/sdk",
    "@inquirer/prompts",
    "cli-table3",
    "ora",
    "commander",
    "zod",
    "env-paths",
    "sql.js",
    "node-llama-cpp",
    "@xenova/transformers",
  ],
});
