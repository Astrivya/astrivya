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
];

export function buildToolList(pluginTools: ToolPlugin[]): any[] {
  return [
    ...CORE_TOOL_DEFINITIONS,
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
