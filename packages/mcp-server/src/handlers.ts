import crypto from "node:crypto";
import { AkgQuery, type AkgStorage, GraphTraversal, ImpactAnalyzer } from "@astrivya/akg-core";
import { API_PATHS, getConfig, syncCall } from "./api";
import type { ToolPlugin } from "./plugin";

let storage: AkgStorage | null = null;
let query: AkgQuery | null = null;
let _graphTraversal: GraphTraversal | null = null;
let _impactAnalyzer: ImpactAnalyzer | null = null;
let workspacePath = "";
let _toolPlugins: ToolPlugin[] = [];

const SYNC_KEY = process.env.ASTRIVYA_SYNC_KEY || "";
const CLOUD_URL = process.env.ASTRIVYA_CLOUD_URL || "";

async function trySync(data: { nodes: any[]; edges?: any[] }) {
  if (!SYNC_KEY && !getConfig().token) return;
  const baseUrl = CLOUD_URL || getConfig().syncUrl;
  const key = SYNC_KEY || getConfig().token;
  if (!baseUrl || !key) return;
  try {
    await fetch(`${baseUrl}${API_PATHS.AKG_SYNC_PUSH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // fire-and-forget
  }
}

export function setAkgStorage(s: AkgStorage, wp: string) {
  storage = s;
  workspacePath = wp;
  query = new AkgQuery(s, wp);
  _graphTraversal = new GraphTraversal(s);
  _impactAnalyzer = new ImpactAnalyzer(s);
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

const LOCAL_HANDLERS: Record<
  string,
  (args: any) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
> = {
  search_memories: async (args) => {
    const q = args?.query || "";
    const limit = args?.limit || 8;
    const results = await getQuery().semanticSearch(q, limit);

    let cloudNodes: any[] = [];
    if (getConfig().syncUrl && getConfig().token) {
      try {
        const cloud = await syncCall(API_PATHS.AKG_SYNC_SEARCH, "POST", { query: q, limit });
        cloudNodes = (cloud.nodes || []).map((n: any) => ({
          id: n.id,
          label: n.label,
          content: n.content,
          type: n.type,
          source: "cloud",
          score: 1,
          filePath: n.metadata?.filePath || "",
        }));
      } catch {
        // sync unavailable — use local results only
      }
    }

    const seen = new Set(results.map((r: any) => r.id));
    const merged = [...results, ...cloudNodes.filter((n) => !seen.has(n.id))].slice(0, limit);

    return { content: [{ type: "text", text: JSON.stringify(merged, null, 2) }] };
  },

  get_person_context: async () => {
    const s = getStorage();
    const stats = s.getStats();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              workspace: workspacePath,
              indexedFiles: stats.nodes,
              knowledgeChunks: stats.chunks,
              relationships: stats.edges,
              status: stats.nodes > 0 ? "ready" : "empty — run `astrivya akg init` to index",
            },
            null,
            2,
          ),
        },
      ],
    };
  },

  get_team_context: async () => {
    const s = getStorage();
    const stats = s.getStats();
    const { syncUrl, token } = getConfig();

    let note = "Cloud API unavailable - using local AKG stats";
    if (syncUrl && token) {
      try {
        const cloud = await syncCall(API_PATHS.BRIEFING_DAILY(), "GET");
        note = "Synced team context from cloud";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { workspace: workspacePath, nodes: stats.nodes, edges: stats.edges, chunks: stats.chunks, cloud, note },
                null,
                2,
              ),
            },
          ],
        };
      } catch {
        // fall through to local
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { workspace: workspacePath, nodes: stats.nodes, edges: stats.edges, chunks: stats.chunks, note },
            null,
            2,
          ),
        },
      ],
    };
  },

  get_team_members: async () => {
    const { syncUrl, token } = getConfig();
    let members: any[] = [];
    let note = "Local mode - no team configured";
    if (syncUrl && token) {
      try {
        const cloud = await syncCall("/api/team/members", "GET");
        members = cloud.members || [];
        note = "Synced from cloud";
      } catch {
        members = [];
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ members, note }, null, 2) }],
    };
  },

  get_team_analytics: async () => {
    const s = getStorage();
    const stats = s.getStats();
    const note = "Local mode - analytics computed from local AKG";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ nodes: stats.nodes, edges: stats.edges, chunks: stats.chunks, note }, null, 2),
        },
      ],
    };
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
    return {
      content: [{ type: "text", text: JSON.stringify({ notifications, note }, null, 2) }],
    };
  },

  mark_notification_read: async (_args) => {
    const { syncUrl, token } = getConfig();
    const note = "Local mode - no notifications to sync";
    if (syncUrl && token) {
      try {
        const id = _args?.id;
        await syncCall("/api/notifications/read", "PATCH", { id });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, note: "Marked read in cloud" }) }],
        };
      } catch {
        // fall through to local
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, note }) }],
    };
  },

  get_expertise_profile: async () => {
    const s = getStorage();
    const rows = s.runQuery("SELECT type, COUNT(*) AS count FROM nodes GROUP BY type");
    const expertise = (rows || []).map((r: any) => ({
      area: r.type,
      count: Number(r.count || 0),
    }));
    const note = "Local AKG mode - expertise derived from local node types";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ workspace: workspacePath, expertise, note }, null, 2),
        },
      ],
    };
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
      s.addEdge({
        source: id,
        target: `file::${fileContext.replace(/^.*[\\/]/, "")}`,
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

    return { content: [{ type: "text", text: `Decision logged: ${id}` }] };
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

    return { content: [{ type: "text", text: `Memory stored: ${id}` }] };
  },

  search_connectors: async (args) => {
    const q = args?.query || "";
    const limit = args?.limit || 10;
    const results = await getQuery().semanticSearch(q, limit);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },

  get_daily_briefing: async (args) => {
    const limit = args?.limit || 5;
    const date = new Date().toISOString().split("T")[0];

    if (getConfig().syncUrl && getConfig().token) {
      try {
        const cloud = await syncCall(API_PATHS.BRIEFING_DAILY(limit), "GET");
        const briefings = cloud?.briefings || [];
        if (briefings.length > 0 && briefings[0].id) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    date,
                    briefings,
                    source: "cloud",
                    note: "Cloud-synced daily briefing",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              date,
              recentActivity: recentNodes,
              note: "Local AKG mode — briefing based on workspace activity",
            },
            null,
            2,
          ),
        },
      ],
    };
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ term, results: related.slice(0, limit) }, null, 2),
        },
      ],
    };
  },

  trace_decision: async (args) => {
    const s = getStorage();
    const decisionId = args?.decision_id || "";
    if (!decisionId) return { content: [{ type: "text", text: "decision_id is required" }], isError: true };

    const node = s.getNode(decisionId);
    if (!node) {
      return {
        content: [{ type: "text", text: `Decision "${decisionId}" not found in local AKG` }],
      };
    }

    const neighbors = s.getNeighbors(decisionId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              decision: node,
              relationships: neighbors.map((n) => ({
                direction: n.direction === "out" ? "depends_on" : "depended_by",
                node: n.node.label,
                nodeId: n.node.id,
                relation: n.relation,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export async function handleToolCall(
  name: string,
  args: any,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
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

export async function handleReadResource(
  uri: string,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  try {
    const s = getStorage();

    if (uri.startsWith("astrivya://team/")) {
      const stats = s.getStats();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ workspace: workspacePath, ...stats }, null, 2),
          },
        ],
      };
    }

    if (uri.startsWith("astrivya://user/")) {
      const stats = s.getStats();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ workspace: workspacePath, ...stats }, null, 2),
          },
        ],
      };
    }

    if (uri === "astrivya://briefing/today") {
      const recentNodes = s.runQuery("SELECT id, label, type, updated_at FROM nodes ORDER BY updated_at DESC LIMIT 10");
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ recentActivity: recentNodes }, null, 2),
          },
        ],
      };
    }

    if (uri === "astrivya://org/knowledge-graph") {
      const nodes = s.runQuery("SELECT id, label, type FROM nodes LIMIT 50");
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ nodes, workspace: workspacePath }, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unsupported resource URI: ${uri}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Astrivya MCP] Resource read error for ${uri}:`, message);
    throw err;
  }
}
