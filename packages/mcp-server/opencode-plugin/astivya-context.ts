/**
 * Astrivya OpenCode workspace plugin (R1 auto-inject).
 *
 * Reads the context digest the Astrivya MCP server persists at
 * `<workspace>/.astrivya/mcp/context-digest.json` and injects it into the
 * system prompt of every session as a compact prose block (< ~1.5k tokens).
 *
 * Zero runtime dependencies: it only reads one JSON file, so it works even
 * when @astrivya/* is not installed in the agent host environment.
 *
 * Install: copy this file into `.opencode/plugin/` (auto-discovered), or add
 * the path to the `plugin` array in opencode.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_DIGEST_CHARS = 6000;
const BLOCK_MARKER = "ASTRIVYA CONTEXT DIGEST";

interface SystemTransformOutput {
  system: string[];
}

export default async function astrivyaContext(input: { directory: string }): Promise<Record<string, unknown>> {
  const digestPath = () => path.join(input.directory, ".astrivya", "mcp", "context-digest.json");

  const loadDigest = (): {
    digest: {
      summary?: string;
      recent?: string[];
      action_items?: string[];
      counts?: Record<string, number>;
    };
    refreshed_at?: string;
  } | null => {
    try {
      const p = digestPath();
      if (!fs.existsSync(p)) return null;
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.digest) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const buildBlock = (data: NonNullable<ReturnType<typeof loadDigest>>): string => {
    const d = data.digest;
    const lines: string[] = [];
    lines.push(`${BLOCK_MARKER} (fresh: ${data.refreshed_at ?? "unknown"}):`);
    if (d.summary) lines.push(d.summary);
    if (d.recent?.length) lines.push(`Recent: ${d.recent.join(", ")}`);
    if (d.counts) lines.push(`Graph: ${JSON.stringify(d.counts)}`);
    if (d.action_items?.length) lines.push(`Suggested actions: ${d.action_items.join(" | ")}`);
    lines.push("For details call search_memories / get_daily_briefing / get_context_digest.");
    return lines.join("\n");
  };

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: SystemTransformOutput): Promise<void> => {
      const data = loadDigest();
      if (!data) return;
      if (output.system.some((m) => m.startsWith(BLOCK_MARKER))) return;
      output.system.push(buildBlock(data).slice(0, MAX_DIGEST_CHARS));
    },
  };
}
