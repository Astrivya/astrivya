import { defineConfig } from "tsup";

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
  external: ["@astrivya/akg-core", "@xenova/transformers"],
});
