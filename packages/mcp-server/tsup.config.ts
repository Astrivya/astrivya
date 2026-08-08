import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { index: "src/index.ts" },
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
  external: ["@astrivya/akg-indexer", "@modelcontextprotocol/sdk", "zod", "env-paths"],
});
