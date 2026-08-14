import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface ContractEndpoint {
  path: string;
  methods: string[];
}

/**
 * Canonical cloud contract (mirrored by the Astrivya-MVP repo's
 * src/lib/cloud-contract.test.ts). cwd is the workspace dir under
 * `npm -w packages/cli run test`, so the manifest lives at ../../cloud-contract.json.
 */
const ROOT = path.join(process.cwd(), "..", "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "cloud-contract.json"), "utf-8")) as {
  endpoints: ContractEndpoint[];
};

const CLIENT_DIRS = ["packages/cli/src", "packages/mcp-server/src", "packages/plugin-runtime/src"];

function clientSource(): string {
  const parts: string[] = [];
  for (const dir of CLIENT_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          parts.push(fs.readFileSync(p, "utf-8"));
        }
      }
    };
    walk(abs);
  }
  return parts.join("\n");
}

function isReferenced(entry: ContractEndpoint, src: string): boolean {
  if (entry.path.includes("{provider}")) {
    // The client spells the placeholder as a template literal: ${provider}
    return src.includes(entry.path.replace("{provider}", "${provider}"));
  }
  return src.includes(entry.path);
}

describe("cloud contract — published clients ↔ api.astrivya.ai", () => {
  const src = clientSource();

  it("every manifest endpoint is referenced by a published client", () => {
    const missing = MANIFEST.endpoints.filter((e) => !isReferenced(e, src)).map((e) => e.path);
    expect(missing, `contract endpoints no client references:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every cloud /api path used by a client is listed in the manifest", () => {
    const literals = [...src.matchAll(/["'`](\/api\/[a-zA-Z0-9/_{}$.-]+)["'`]/g)].map((m) => m[1]);
    const paths = [...new Set(literals.map((p) => p.replace(/\?.*$/, "")))];
    const manifest = new Set(MANIFEST.endpoints.map((e) => e.path));

    const unknown = paths
      .filter((p) => !manifest.has(p) && !manifest.has(p.replace("${provider}", "{provider}")))
      // /api/akg/* and /api/mcp/* are the CLI's LOCAL HTTP endpoints (atlas
      // graph server + MCP session-status proxy), not the cloud — out of
      // scope for this contract.
      .filter((p) => (!p.startsWith("/api/akg/") && !p.startsWith("/api/mcp/")) || manifest.has(p));

    expect(unknown, `client paths missing from cloud-contract.json:\n${unknown.join("\n")}`).toEqual([]);
  });
});
