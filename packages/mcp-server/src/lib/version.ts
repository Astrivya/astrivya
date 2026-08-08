// Injected at build time via tsup `define`. The fallback keeps the source
// runnable outside the bundle (e.g. `tsx src/index.ts`).
export const CURRENT_VERSION: string = process.env.__PACKAGE_VERSION__ || "0.1.0";
