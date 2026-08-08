import type { LocalManifestEntry } from "@astrivya/plugin-api";
import { PluginDownloader } from "./plugin-downloader";

export interface VerificationResult {
  ok: boolean;
  entries: Array<{
    id: string;
    state: "verified" | "corrupted";
    error?: string;
  }>;
}

export class PluginVerifier {
  async verifyAll(pluginsDir: string, entries: LocalManifestEntry[]): Promise<VerificationResult> {
    const downloader = new PluginDownloader();
    const results: VerificationResult["entries"] = [];

    for (const entry of entries) {
      const pluginDir = joinPath(pluginsDir, entry.id);
      try {
        const valid = await downloader.verifyHash(pluginDir, entry.sha256);
        results.push({
          id: entry.id,
          state: valid ? "verified" : "corrupted",
          ...(valid ? {} : { error: "SHA-256 mismatch" }),
        });
      } catch (err) {
        results.push({
          id: entry.id,
          state: "corrupted",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      ok: results.every((r) => r.state === "verified"),
      entries: results,
    };
  }
}

function joinPath(...parts: string[]): string {
  const { join } = require("node:path");
  return join(...parts);
}
