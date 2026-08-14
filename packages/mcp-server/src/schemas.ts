import type { ToolPlugin } from "./plugin";

export const CORE_TOOL_DEFINITIONS = [
  {
    name: "search_memories",
    description:
      "Search across personal, team, and workspace memories with semantic similarity and temporal re-ranking.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query (e.g. 'how does auth work?')" },
        space_id: { type: "string", description: "Optional space ID to restrict search context." },
        limit: { type: "number", description: "Number of matches to return (default: 8)." },
        active_file: {
          type: "string",
          description: "Optional current active file path to boost relevance.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_person_context",
    description: "Retrieve developer context, active sessions, configuration details, and recent briefings.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_team_context",
    description:
      "Retrieve team context (active members, decisions, activity). Falls back to local AKG stats when the cloud API is unavailable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_team_members",
    description: "List team members. Returns an empty list in local mode when the cloud API is unavailable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_team_analytics",
    description: "Retrieve team analytics. Falls back to local AKG stats in local mode.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_notifications",
    description: "List notifications. Returns an empty list in local mode when the cloud API is unavailable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mark_notification_read",
    description: "Mark a notification as read. Returns ok in local mode when the cloud API is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Notification ID to mark as read" },
      },
    },
  },
  {
    name: "get_expertise_profile",
    description: "Retrieve the expertise profile. Falls back to local node type counts in local AKG mode.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_credits",
    description:
      "Check the current user's live credit balance, lifetime usage, and recent transactions from the cloud. Fails gracefully when the cloud is unreachable.",
    inputSchema: {
      type: "object",
      properties: {
        transactions: {
          type: "number",
          description: "Optional number of recent transactions to include (default: 0)",
        },
      },
    },
  },
  {
    name: "log_decision",
    description: "Record a code design or architectural decision in the team dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the decision" },
        content: { type: "string", description: "Reasoning and details of the decision" },
        file_context: {
          type: "string",
          description: "Optional active file context related to the decision",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "log_memory",
    description: "Log a custom memory (fact, preference, goal, habit) to the developer's cognitive layer.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory description to store" },
        type: {
          type: "string",
          enum: ["fact", "preference", "goal", "insight", "habit", "project", "relationship", "event"],
          description: "Type of the memory (default: 'fact')",
        },
        visibility: {
          type: "string",
          enum: ["personal", "team", "org"],
          description: "Visibility scope of the memory (default: 'personal')",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "search_connectors",
    description:
      "Search indexed documentation chunks from external connected integrations (GitHub, Notion, Jira, Slack).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        provider: {
          type: "string",
          description: "Optional provider filter (e.g. 'github', 'notion', 'jira', 'slack')",
        },
        limit: { type: "number", description: "Limit results count (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_mcp_status",
    description:
      "Retrieve the MCP server's own status — uptime, live session registry (per-session id, client, tool counts, last tool), per-tool latency p50/p95, and recent activity journal.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_daily_briefing",
    description: "Fetch the developer's latest daily work context briefings.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of briefings to fetch (default: 1)" },
      },
    },
  },
  {
    name: "find_related_knowledge",
    description: "Find concepts and memories related to a given term via semantic knowledge graph search.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "The concept or term to find related knowledge for" },
        team_id: { type: "string", description: "Optional team ID to scope the search" },
        limit: { type: "number", description: "Number of related results (default: 5)" },
      },
      required: ["term"],
    },
  },
  {
    name: "trace_decision",
    description:
      "Trace a decision through the knowledge graph — find causes, related decisions, and cross-tool context.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string", description: "UUID of the decision to trace" },
        max_depth: { type: "number", description: "Maximum traversal depth (default: 3)" },
      },
      required: ["decision_id"],
    },
  },
  {
    name: "get_context_digest",
    description:
      "Compact pre-digested context for session start: recent activity, active areas, and action items in prose.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent items to consider (default: 8)" },
      },
    },
  },
  {
    name: "get_workspace_updates",
    description:
      "Return knowledge-graph changes since a timestamp (delta). Use to catch up mid-session or poll for newly indexed files.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO timestamp to diff from (default: 24h ago)",
        },
        limit: { type: "number", description: "Max items to return (default: 20)" },
      },
    },
  },
];

/**
 * Cost / quality / "when to use" hints per tool (D1, D4). Surfaced in the tool
 * description so a caller can decide cheaply whether a call is worth making.
 */
const TOOL_META: Record<
  string,
  { when: string; cost: "cheap" | "moderate" | "expensive"; quality: "high" | "medium" | "low" }
> = {
  search_memories: {
    when: "Before answering a question about past work, decisions, or project context",
    cost: "cheap",
    quality: "high",
  },
  get_person_context: {
    when: "To orient at session start or when asked about your own setup/work",
    cost: "cheap",
    quality: "medium",
  },
  get_team_context: { when: "To see what teammates have worked on or decided", cost: "moderate", quality: "medium" },
  get_team_members: { when: "To list who is on the team", cost: "moderate", quality: "medium" },
  get_team_analytics: { when: "To see team activity metrics", cost: "moderate", quality: "medium" },
  list_notifications: { when: "To check for unread alerts", cost: "moderate", quality: "medium" },
  mark_notification_read: { when: "After acting on a notification", cost: "cheap", quality: "high" },
  get_expertise_profile: { when: "To find who/what covers an area", cost: "cheap", quality: "medium" },
  log_decision: {
    when: "When you make an architectural or design choice worth remembering",
    cost: "cheap",
    quality: "high",
  },
  log_memory: { when: "When you learn a fact or preference worth persisting", cost: "cheap", quality: "high" },
  search_connectors: {
    when: "To pull docs from GitHub/Notion/Jira/Slack integrations",
    cost: "moderate",
    quality: "medium",
  },
  get_mcp_status: { when: "To diagnose whether the MCP server is healthy", cost: "cheap", quality: "high" },
  get_daily_briefing: { when: "At session start to see today's activity summary", cost: "cheap", quality: "high" },
  find_related_knowledge: { when: "To discover related concepts for a term", cost: "cheap", quality: "medium" },
  trace_decision: {
    when: "To see what a decision depends on and what depends on it",
    cost: "cheap",
    quality: "medium",
  },
  get_context_digest: { when: "Session start — compact prose digest (<1.5k tokens)", cost: "cheap", quality: "high" },
  get_workspace_updates: { when: "Mid-session catch-up or delta polling", cost: "cheap", quality: "medium" },
};

function enrichDescription(name: string, description: string): string {
  const meta = TOOL_META[name];
  if (!meta) return description;
  return `${description} When to use: ${meta.when}. Cost: ${meta.cost} (local). Quality: ${meta.quality}.`;
}

export function buildToolList(pluginTools: ToolPlugin[]): any[] {
  return [
    ...CORE_TOOL_DEFINITIONS.map((t) => ({
      ...t,
      description: enrichDescription(t.name, t.description),
    })),
    ...pluginTools.map((p) => ({
      name: p.name,
      description: p.description,
      inputSchema: p.inputSchema,
    })),
  ];
}

export const RESOURCE_DEFINITIONS = [
  {
    uri: "astrivya://team/active/knowledge",
    name: "Active Team Knowledge & Members",
    description: "Retrieves list of active team members and recent team decisions.",
    mimeType: "application/json",
  },
  {
    uri: "astrivya://user/active/memories",
    name: "User Personal Memories",
    description: "Retrieves user personal cognitive memories.",
    mimeType: "application/json",
  },
  {
    uri: "astrivya://briefing/today",
    name: "Today's Context Briefing",
    description: "Retrieves the developer's latest daily work briefings.",
    mimeType: "application/json",
  },
  {
    uri: "astrivya://org/knowledge-graph",
    name: "Organization Knowledge Graph",
    description: "Retrieves all concepts in the organization's knowledge graph.",
    mimeType: "application/json",
  },
];
