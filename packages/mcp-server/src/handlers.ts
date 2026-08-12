import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AkgQuery, type AkgStorage } from "@astrivya/akg-core";
import { API_PATHS, getConfig, syncCall } from "./api";
import type { ToolPlugin } from "./plugin";
import { getStatus, readJournal } from "./status";

let storage: AkgStorage | null = null;
let query: AkgQuery | null = null;
let workspacePath = "";
let _toolPlugins: ToolPlugin[] = [];

const SYNC_KEY = process.env.ASTRIVYA_SYNC_KEY || "";
const CLOUD_URL = process.env.ASTRIVYA_CLOUD_URL || "";
const DAY_MS = 24 * 60 * 60 * 1000;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

interface DigestFreshness {
  fetchedAt: string;
  lastUpdatedAt?: string;
  stale?: boolean;
}

async function trySync(data: { nodes: any[]; edges?: any[] }) {
  if (!SYNC_KEY && !getConfig().token) return;
  const baseUrl = CLOUD_URL || getConfig().syncUrl;
  const key = SYNC_KEY || getConfig().token;
  const orgId = getConfig().orgId;
  if (!baseUrl || !key || !orgId) return;
  try {
    const toNode = (n: any) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      ...(typeof n.content === "string" ? { content: n.content } : {}),
      metadata: typeof n.metadata === "string" ? safeParseMetadata(n.metadata) : n.metadata,
    });
    const payload = {
      org_id: orgId,
      nodes: data.nodes.map(toNode),
      ...(data.edges?.length ? { edges: data.edges } : {}),
    };
    await fetch(`${baseUrl}${API_PATHS.AKG_SYNC_PUSH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // fire-and-forget
  }
}

function safeParseMetadata(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function setAkgStorage(s: AkgStorage, wp: string) {
  storage = s;
  workspacePath = wp;
  query = new AkgQuery(s, wp);
}

export function setToolPlugins(plugins: ToolPlugin[]) {
  _toolPlugins = plugins;
}

function getStorage(): AkgStorage {
  if (!storage) throw new Error("AKG storage not initialized. Run `astrivya akg init` first.");
  return storage;
}

function getQuery(): AkgQuery {
  if (!query) throw new Error("AKG query not initialized");
  return query;
}

// ---------------------------------------------------------------------------
// Canonical response envelope (R4 freshness + D5 source, D4 cost/quality).
// Every tool/resource resolves to `{ data, source, freshness, note, meta }`.
// ---------------------------------------------------------------------------

function iso(ts?: number | null): string | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  return new Date(ts).toISOString();
}

function localFreshness(): DigestFreshness {
  const s = getStorage();
  const row = s.runQuery("SELECT MAX(updated_at) AS m FROM nodes")[0] as { m?: number | null } | undefined;
  const lastUpdatedAt = iso(row?.m);
  const fetchedAt = new Date().toISOString();
  return {
    fetchedAt,
    lastUpdatedAt,
    stale: typeof row?.m === "number" ? Date.now() - row.m > 30 * DAY_MS : undefined,
  };
}

function envelopePayload<T>(
  data: T,
  opts: {
    source?: "local" | "cloud";
    note?: string;
    cost?: "cheap" | "moderate" | "expensive";
    quality?: "high" | "medium" | "low";
    freshness?: DigestFreshness;
  } = {},
): Record<string, unknown> {
  const { source = "local", note, cost = "cheap", quality = "medium", freshness = localFreshness() } = opts;
  const payload: Record<string, unknown> = { data, source, freshness, meta: { cost, quality } };
  if (note) payload.note = note;
  return payload;
}

function envelope<T>(data: T, opts: Parameters<typeof envelopePayload>[1] = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(envelopePayload(data, opts), null, 2) }] };
}

// ---------------------------------------------------------------------------
// Prose helpers (R6: pre-digested summaries instead of raw JSON).
// Deterministic, LLM-free — cheap enough to run on every call.
// ---------------------------------------------------------------------------

interface BriefNode {
  id: string;
  label: string;
  type: string;
  content?: string;
  updated_at?: number;
}

function proseSummary(nodes: BriefNode[], stats: { nodes: number; chunks: number; embeddings: number }): string {
  const nonChunk = nodes.filter((n) => n.type !== "chunk");
  const sentences: string[] = [];

  const files = nonChunk.filter((n) => n.type === "file");
  const adrs = nonChunk.filter((n) => n.type === "adr");
  const memories = nonChunk.filter((n) => n.type === "agent_action");
  const others = nonChunk.length - files.length - adrs.length - memories.length;

  const areas = nonChunk
    .map((n) => n.label)
    .filter((l): l is string => !!l)
    .slice(0, 3);
  const areaText = areas.length ? ` Active areas include: ${areas.join(", ")}.` : "";

  if (nonChunk.length === 0) {
    if (nodes.length > 0) {
      sentences.push(`The knowledge graph recently indexed ${nodes.length} new chunk${nodes.length === 1 ? "" : "s"}.`);
    } else {
      sentences.push("No indexed activity in the current window.");
    }
  } else {
    const parts = [];
    if (files.length) parts.push(`${files.length} file${files.length === 1 ? "" : "s"}`);
    if (adrs.length) parts.push(`${adrs.length} decision${adrs.length === 1 ? "" : "s"}`);
    if (memories.length) parts.push(`${memories.length} memor${memories.length === 1 ? "y" : "ies"}`);
    if (others) parts.push(`${others} other item${others === 1 ? "" : "s"}`);
    sentences.push(
      `The workspace saw ${nonChunk.length} recent change${nonChunk.length === 1 ? "" : "s"} (${parts.join(", ")}).`,
    );
  }
  if (stats.chunks > 0) {
    sentences.push(
      `The knowledge graph holds ${stats.nodes} nodes, ${stats.chunks} chunks and ${stats.embeddings} embeddings.`,
    );
  }
  sentences.push(`${areaText} Run \`astrivya akg reindex\` to refresh stale files.`);

  return sentences.filter(Boolean).join(" ").trim();
}

function actionItems(nodes: BriefNode[], stats: { nodes: number; chunks: number; embeddings: number }): string[] {
  const items: string[] = [];
  if (stats.nodes === 0) items.push("Run `astrivya akg init` to index the workspace first.");
  if (stats.chunks > stats.embeddings)
    items.push("Some chunks lack embeddings — run `astrivya akg init` (embeds by default) to backfill.");
  const oldest = nodes.length ? nodes[nodes.length - 1] : undefined;
  if (oldest && typeof oldest.updated_at === "number" && Date.now() - oldest.updated_at > 30 * DAY_MS)
    items.push("Recent activity is old — the graph may be stale; reindex to refresh.");
  const adrs = nodes.filter((n) => n.type === "adr");
  if (adrs.length > 0) items.push("Review the logged decisions above before making related changes.");
  return items;
}

function toBriefNode(r: Record<string, unknown>): BriefNode {
  return {
    id: String(r.id ?? ""),
    label: String(r.label ?? r.id ?? ""),
    type: String(r.type ?? "unknown"),
    content: r.content != null ? String(r.content) : undefined,
    updated_at: typeof r.updated_at === "number" ? r.updated_at : undefined,
  };
}

// ---------------------------------------------------------------------------
// Context digest (R1). Built from the local graph and persisted to
// `<workspace>/.astrivya/mcp/context-digest.json` so an OpenCode workspace
// plugin can auto-inject it into the system prompt without any dependency on
// @astrivya packages at runtime.
// ---------------------------------------------------------------------------

function buildDigestPayload(limit: number): {
  digest: {
    workspace: string;
    summary: string;
    recent: string[];
    action_items: string[];
    counts: { nodes: number; chunks: number; embeddings: number };
  };
  approx_tokens: number;
  team?: Record<string, unknown>;
} {
  const s = getStorage();
  const stats = s.getStats();
  const since = Date.now() - DAY_MS;
  const recentNodes = s.runQuery(
    "SELECT id, label, type, content, updated_at FROM nodes WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
    [since, limit],
  );
  const nodes = recentNodes.map(toBriefNode);

  const summary = proseSummary(nodes, stats);
  const actions = actionItems(nodes, stats);
  const topLabels = nodes
    .filter((n) => n.type !== "chunk" && n.label && n.label.length <= 60)
    .slice(0, 5)
    .map((n) => n.label);

  const digest = {
    workspace: workspacePath,
    summary,
    recent: topLabels,
    action_items: actions,
    counts: { nodes: stats.nodes, chunks: stats.chunks, embeddings: stats.embeddings },
  };

  // ~4 chars/token rough cap; the digest is intentionally compact (R1: <1.5k tokens).
  const approxTokens = Math.ceil(JSON.stringify(digest).length / 4);
  return { digest, approx_tokens: approxTokens };
}

function digestFilePath(): string {
  return path.join(workspacePath, ".astrivya", "mcp", "context-digest.json");
}

/** Best-effort write of the latest digest for the OpenCode plugin to read. */
function persistDigest(payload: ReturnType<typeof buildDigestPayload>): void {
  try {
    fs.mkdirSync(path.dirname(digestFilePath()), { recursive: true });
    fs.writeFileSync(digestFilePath(), JSON.stringify({ ...payload, refreshed_at: new Date().toISOString() }, null, 2));
  } catch {
    // Digest persistence is best-effort; never break a tool call over it.
  }
}

/**
 * Recompute + persist the digest. Called at server startup so the plugin has
 * data immediately. Fetches the team block when running in team mode.
 */
export async function refreshContextDigest(): Promise<void> {
  if (!storage) return;
  try {
    const payload = buildDigestPayload(8);
    if (getConfig().teamId) {
      const team = await teamDigestBlock();
      if (team) payload.team = team;
    }
    persistDigest(payload);
  } catch {
    // best-effort
  }
}

/**
 * Compact team block for the session-start digest. Only resolves when the
 * server runs in team mode (ASTRIVYA_TEAM_MCP / `--team <id>`): fetches the
 * org context from the cloud and flattens it to a few prose lines. Returns
 * undefined when not in team mode or the cloud is unreachable — the digest
 * must never fail over a cloud call.
 */
async function teamDigestBlock(): Promise<Record<string, unknown> | undefined> {
  const { syncUrl, token, teamId } = getConfig();
  if (!syncUrl || !token || !teamId) return undefined;
  try {
    const cloud = await syncCall(API_PATHS.TEAM_CONTEXT, "GET");
    const org = cloud?.org;
    const members = (cloud?.members || []).length;
    const decisions = (cloud?.recentDecisions || []).slice(0, 3).map((d: any) => d.title);
    return {
      mcpId: teamId,
      name: org?.name ?? null,
      members,
      recent_decisions: decisions,
    };
  } catch {
    return undefined;
  }
}

/**
 * Cloud keyword search over the org graph. The cloud search endpoint accepts
 * only a query string (embeddings are not part of its contract), so this
 * never claims vector mode. Returns `{ nodes, mode }`; never throws.
 */
async function cloudSearchNodes(
  query: string,
  _embedding: number[] | undefined,
  limit: number,
): Promise<{ nodes: any[]; mode: string }> {
  const { syncUrl, token, orgId } = getConfig();
  if (!syncUrl || !token) return { nodes: [], mode: "none" };
  try {
    const body: Record<string, unknown> = { query, limit };
    if (orgId) body.org_id = orgId;
    const cloud = await syncCall(API_PATHS.AKG_SYNC_SEARCH, "POST", body);
    return { nodes: cloud.nodes || [], mode: cloud.mode || "keyword" };
  } catch {
    return { nodes: [], mode: "none" };
  }
}

// ---------------------------------------------------------------------------
// Local tool handlers
// ---------------------------------------------------------------------------

const LOCAL_HANDLERS: Record<string, (args: any) => Promise<ToolResult>> = {
  search_memories: async (args) => {
    const q = args?.query || "";
    const limit = args?.limit || 8;
    const results = await getQuery().retrieve(q, limit);

    let cloudNodes: any[] = [];
    let source: "local" | "cloud" = "local";
    let note: string | undefined;
    if (getConfig().syncUrl && getConfig().token) {
      const embedding = await getQuery().embedQuery(q);
      const { nodes, mode } = await cloudSearchNodes(q, embedding, limit);
      cloudNodes = nodes.map((n: any) => ({
        id: n.id,
        label: n.label,
        content: n.content,
        type: n.type,
        source: mode === "vector" ? "cloud-vector" : "cloud",
        score: typeof n.score === "number" ? n.score : 1,
        filePath: n.metadata?.filePath || "",
      }));
      if (cloudNodes.length > 0) {
        source = "cloud";
        note = mode === "vector" ? "Merged cloud vector + local results" : "Merged cloud keyword + local results";
      }
    }

    const seen = new Set(results.map((r: any) => r.id ?? r.chunkId ?? r.nodeId));
    const merged = [...results, ...cloudNodes.filter((n) => !seen.has(n.id))].slice(0, limit);

    const semanticAvailable = await getQuery().semanticAvailable();
    if (!semanticAvailable) {
      note =
        "Local knowledge graph is empty or the semantic embedder is unavailable — results are keyword (FTS) matches only. Run `astrivya akg init --index` to index files.";
    }

    return envelope({ results: merged }, { source, note, quality: semanticAvailable ? "high" : "low" });
  },

  get_mcp_status: async () => {
    const status = getStatus();
    const s = getStorage();
    const stats = s.getStats();
    const journal = readJournal(workspacePath, 20);
    return envelope(
      { ...status, akg: { nodes: stats.nodes, edges: stats.edges, chunks: stats.chunks }, recentEvents: journal },
      { note: "MCP server health snapshot", quality: "high" },
    );
  },

  get_person_context: async () => {
    const s = getStorage();
    const stats = s.getStats();
    return envelope(
      {
        workspace: workspacePath,
        indexedFiles: stats.nodes,
        knowledgeChunks: stats.chunks,
        relationships: stats.edges,
        status: stats.nodes > 0 ? "ready" : "empty — run `astrivya akg init` to index",
      },
      { note: "Local developer context", quality: stats.nodes > 0 ? "high" : "low" },
    );
  },

  get_team_context: async () => {
    const s = getStorage();
    const stats = s.getStats();
    const { syncUrl, token, teamId } = getConfig();

    const note = "Cloud API unavailable - using local AKG stats";
    const team = { teamId: teamId || null };
    if (syncUrl && token) {
      try {
        const cloud = await syncCall(API_PATHS.TEAM_CONTEXT, "GET");
        return envelope(
          { workspace: workspacePath, nodes: stats.nodes, edges: stats.edges, chunks: stats.chunks, team, cloud },
          { source: "cloud", note: "Synced team context from cloud", quality: "high" },
        );
      } catch {
        // fall through to local
      }
    }

    return envelope(
      { workspace: workspacePath, nodes: stats.nodes, edges: stats.edges, chunks: stats.chunks, team },
      { note },
    );
  },

  get_team_members: async () => {
    const { syncUrl, token } = getConfig();
    let members: any[] = [];
    let note = "Local mode - no team configured";
    if (syncUrl && token) {
      try {
        const cloud = await syncCall(API_PATHS.TEAM_MEMBERS, "GET");
        members = cloud.members || [];
        note = "Synced from cloud";
      } catch {
        members = [];
      }
    }
    return envelope({ members }, { source: syncUrl && token ? "cloud" : "local", note });
  },

  get_team_analytics: async () => {
    const s = getStorage();
    const stats = s.getStats();
    return envelope(
      { nodes: stats.nodes, edges: stats.edges, chunks: stats.chunks },
      { note: "Local mode - analytics computed from local AKG" },
    );
  },

  list_notifications: async () => {
    const { syncUrl, token } = getConfig();
    let notifications: any[] = [];
    let note = "Local mode - no notifications";
    if (syncUrl && token) {
      try {
        const cloud = await syncCall("/api/notifications", "GET");
        notifications = cloud.notifications || [];
        note = "Synced from cloud";
      } catch {
        notifications = [];
      }
    }
    return envelope({ notifications }, { source: syncUrl && token ? "cloud" : "local", note });
  },

  check_credits: async (args) => {
    const { syncUrl, token } = getConfig();
    if (!syncUrl || !token) {
      return envelope(
        { error: "Not connected to cloud. Set ASTRIVYA_CLOUD_URL and ASTRIVYA_TOKEN." },
        { source: "local", note: "Cloud not configured" },
      );
    }
    try {
      const balance = await syncCall(API_PATHS.CREDIT_BALANCE, "GET");
      const limit = Math.min(Math.max(Number(args?.transactions) || 0, 0), 20);
      const txs = limit > 0 ? await syncCall(API_PATHS.CREDIT_TRANSACTIONS(limit), "GET") : [];
      return envelope(
        {
          balance: Number(balance?.balance ?? 0),
          lifetime_purchased: Number(balance?.lifetime_purchased ?? 0),
          lifetime_consumed: Number(balance?.lifetime_consumed ?? 0),
          last_monthly_refill_at: balance?.last_monthly_refill_at ?? null,
          recent_transactions: txs || [],
        },
        { source: "cloud", note: "Live from cloud" },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return envelope({ error: message }, { source: "cloud", note: "Failed to fetch credit balance" });
    }
  },

  mark_notification_read: async (_args) => {
    const { syncUrl, token } = getConfig();
    const note = "Local mode - no notifications to sync";
    if (syncUrl && token) {
      try {
        const id = _args?.id;
        await syncCall("/api/notifications/read", "PATCH", { id });
        return envelope({ ok: true }, { source: "cloud", note: "Marked read in cloud", quality: "high" });
      } catch {
        // fall through to local
      }
    }
    return envelope({ ok: true }, { note });
  },

  get_expertise_profile: async () => {
    const s = getStorage();
    const rows = s.runQuery("SELECT type, COUNT(*) AS count FROM nodes GROUP BY type");
    const expertise = (rows || []).map((r: any) => ({
      area: r.type,
      count: Number(r.count || 0),
    }));
    return envelope(
      { workspace: workspacePath, expertise },
      { note: "Local AKG mode - expertise derived from local node types" },
    );
  },

  log_decision: async (args) => {
    const s = getStorage();
    const title = args?.title || "Untitled Decision";
    const content = args?.content || "";
    const fileContext = args?.file_context || "";
    const timestamp = Date.now();
    const id = `decision::${crypto.randomUUID()}`;

    s.upsertNode({
      id,
      label: title,
      type: "adr",
      content,
      sourceFile: fileContext || undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    if (fileContext) {
      const rel = workspacePath
        ? path.relative(workspacePath, path.resolve(workspacePath, fileContext)).replace(/\\/g, "/")
        : fileContext.replace(/^.*[\\/]/, "");
      s.addEdge({
        source: id,
        target: `file::${rel}`,
        relation: "documents",
        weight: 1.0,
      });
    }

    if (getConfig().syncUrl && getConfig().token) {
      syncCall(API_PATHS.DECISIONS, "POST", {
        title,
        content,
        file_context: fileContext || undefined,
      }).catch(() => {});
    }

    trySync({
      nodes: [{ id, label: title, type: "adr", content, createdAt: timestamp, updatedAt: timestamp }],
    });

    return envelope(
      { id, label: title },
      { note: "Decision logged to local AKG (and cloud when configured)", quality: "high" },
    );
  },

  log_memory: async (args) => {
    const s = getStorage();
    const memContent = args?.content || "";
    const memType = args?.type || "insight";
    const timestamp = Date.now();
    const id = `memory::${crypto.randomUUID()}`;

    s.upsertNode({
      id,
      label: memContent.slice(0, 80),
      type: "agent_action",
      content: memContent,
      metadata: JSON.stringify({
        memory_type: memType,
        visibility: args?.visibility || "personal",
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    trySync({
      nodes: [
        {
          id,
          label: memContent.slice(0, 80),
          type: "agent_action",
          content: memContent,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });

    return envelope({ id }, { note: "Memory stored in local AKG", quality: "high" });
  },

  search_connectors: async (args) => {
    const q = args?.query || "";
    const limit = args?.limit || 10;
    const results = await getQuery().semanticSearch(q, limit);
    const semanticAvailable = await getQuery().semanticAvailable();
    return envelope(
      { results },
      {
        note: semanticAvailable ? undefined : "Semantic search unavailable — results are keyword (FTS) matches only.",
        quality: semanticAvailable ? "high" : "low",
      },
    );
  },

  get_daily_briefing: async (args) => {
    const limit = args?.limit || 5;
    const date = new Date().toISOString().split("T")[0];

    if (getConfig().syncUrl && getConfig().token) {
      try {
        const cloud = await syncCall(API_PATHS.BRIEFING_DAILY(limit), "GET");
        const briefings = cloud?.briefings || [];
        if (briefings.length > 0 && briefings[0].id) {
          return envelope(
            { date, briefings },
            { source: "cloud", note: "Cloud-synced daily briefing", quality: "high" },
          );
        }
      } catch {
        // fall through to local
      }
    }

    const s = getStorage();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    const recentNodes = s.runQuery(
      "SELECT id, label, type, content, updated_at FROM nodes WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
      [todayMs, limit],
    );

    const nodes = recentNodes.map(toBriefNode);
    const stats = s.getStats();
    const summary = proseSummary(nodes, stats);
    const actions = actionItems(nodes, stats);

    return envelope(
      { date, recentActivity: nodes, summary, action_items: actions },
      { note: "Local AKG mode — briefing based on workspace activity", quality: "high" },
    );
  },

  get_context_digest: async (args) => {
    const limit = args?.limit || 8;
    const payload = buildDigestPayload(limit);
    const inTeamMode = Boolean(getConfig().teamId);
    if (inTeamMode) {
      const team = await teamDigestBlock();
      if (team) payload.team = team;
    }
    persistDigest(payload);
    return envelope(payload, {
      note: inTeamMode ? "Session-start context digest (team mode)" : "Session-start context digest",
      quality: getStorage().getStats().chunks > 0 ? "high" : "low",
    });
  },

  get_workspace_updates: async (args) => {
    const s = getStorage();
    const limit = args?.limit || 20;
    const sinceMs = args?.since ? new Date(args.since).getTime() : Date.now() - DAY_MS;
    if (!Number.isFinite(sinceMs)) {
      return { content: [{ type: "text", text: "since must be an ISO timestamp" }], isError: true };
    }

    const rows = s.runQuery(
      "SELECT id, label, type, content, updated_at FROM nodes WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
      [sinceMs, limit + 1],
    );
    const nodes = rows.map(toBriefNode);
    const hasMore = nodes.length > limit;
    const page = hasMore ? nodes.slice(0, limit) : nodes;
    const cursor = page.length ? iso(page[0].updated_at) : undefined;

    return envelope(
      { since: iso(sinceMs), updates: page, next_cursor: cursor, has_more: hasMore },
      { note: "Delta of knowledge-graph changes since the given time" },
    );
  },

  find_related_knowledge: async (args) => {
    const term = args?.term || "";
    const limit = args?.limit || 5;
    const results = await getQuery().semanticSearch(term, limit * 2);

    const related = results.map((r: any) => ({
      filePath: r.filePath,
      content: r.content.slice(0, 300),
      score: r.score,
      source: r.source,
    }));

    const semanticAvailable = await getQuery().semanticAvailable();
    return envelope(
      { term, results: related.slice(0, limit) },
      {
        note: semanticAvailable ? undefined : "Semantic search unavailable — results are keyword (FTS) matches only.",
        quality: semanticAvailable ? "high" : "low",
      },
    );
  },

  trace_decision: async (args) => {
    const s = getStorage();
    const decisionId = args?.decision_id || "";
    if (!decisionId) return { content: [{ type: "text", text: "decision_id is required" }], isError: true };

    const node = s.getNode(decisionId);
    if (!node) {
      return envelope({ decision: null }, { note: `Decision "${decisionId}" not found in local AKG` });
    }

    const neighbors = s.getNeighbors(decisionId);

    return envelope(
      {
        decision: node,
        relationships: neighbors.map((n) => ({
          direction: n.direction === "out" ? "depends_on" : "depended_by",
          node: n.node.label,
          nodeId: n.node.id,
          relation: n.relation,
        })),
      },
      { note: "Local knowledge-graph trace", quality: "high" },
    );
  },
};

export async function handleToolCall(name: string, args: any): Promise<ToolResult> {
  try {
    const handler = LOCAL_HANDLERS[name];
    if (handler) {
      return await handler(args);
    }

    const plugin = _toolPlugins.find((p) => p.name === name);
    if (plugin) {
      return await plugin.handle(args);
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

// Resource handlers mirror the tool shapes (D3: one canonical shape per entity).
export async function handleReadResource(
  uri: string,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  const toContents = (payload: unknown): { contents: Array<{ uri: string; mimeType: string; text: string }> } => ({
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
  });

  try {
    const s = getStorage();
    const stats = s.getStats();

    if (uri === "astrivya://briefing/today") {
      const recentNodes = s.runQuery(
        "SELECT id, label, type, content, updated_at FROM nodes ORDER BY updated_at DESC LIMIT 10",
      );
      const nodes = recentNodes.map(toBriefNode);
      const summary = proseSummary(nodes, stats);
      return toContents(
        envelopePayload(
          {
            date: new Date().toISOString().split("T")[0],
            recentActivity: nodes,
            summary,
            action_items: actionItems(nodes, stats),
          },
          { note: "Today's context briefing (local AKG)" },
        ),
      );
    }

    if (uri.startsWith("astrivya://team/")) {
      const recent = s.runQuery(
        "SELECT id, label, type, updated_at FROM nodes WHERE type IN ('adr','agent_action') ORDER BY updated_at DESC LIMIT 10",
      );
      return toContents(
        envelopePayload(
          { workspace: workspacePath, stats, recentDecisions: recent },
          { note: "Active team knowledge (local AKG)" },
        ),
      );
    }

    if (uri.startsWith("astrivya://user/")) {
      const memories = s.runQuery(
        "SELECT id, label, type, updated_at FROM nodes WHERE type = 'agent_action' ORDER BY updated_at DESC LIMIT 10",
      );
      return toContents(
        envelopePayload({ workspace: workspacePath, stats, memories }, { note: "Personal memories (local AKG)" }),
      );
    }

    if (uri === "astrivya://org/knowledge-graph") {
      const nodes = s.runQuery("SELECT id, label, type FROM nodes LIMIT 50");
      return toContents(
        envelopePayload({ workspace: workspacePath, nodes }, { note: "Organization knowledge graph (local AKG)" }),
      );
    }

    throw new Error(`Unsupported resource URI: ${uri}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Astrivya MCP] Resource read error for ${uri}:`, message);
    throw err;
  }
}
