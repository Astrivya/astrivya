# @astrivya/mcp-server

**Model Context Protocol server** for the Astrivya Knowledge Graph. Provides 21 tools that any MCP-compatible client (Claude Desktop, Cursor, Cline, VS Code with Continue, etc.) can use to read, write, and search your local knowledge graph.

```sh
npm install -g @astrivya/mcp-server

# Run with stdio transport (default for Claude Desktop)
astrivya-mcp

# Or as HTTP/SSE on port 3001
astrivya-mcp --http --port 3001
```

## Setup

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "astrivya": {
      "command": "npx",
      "args": ["-y", "@astrivya/mcp-server"]
    }
  }
}
```

### VS Code with Continue

Add to `~/.continue/config.json`:

```json
{
  "experimental": {
    "mcpServers": {
      "astrivya": {
        "command": "npx",
        "args": ["-y", "@astrivya/mcp-server"]
      }
    }
  }
}
```

## Tools

| Tool | Input | Description |
|------|-------|-------------|
| `search_memories` | `query`, `limit?` | Search the knowledge graph with semantic ranking |
| `get_team_context` | `team_id?` | Workspace context (nodes, edges, chunks stats) |
| `get_person_context` | — | Current workspace status |
| `get_mcp_status` | — | MCP server health: uptime, sessions, tool call counters, recent events |
| `log_decision` | `title`, `content`, `file_context?` | Record a design decision |
| `log_memory` | `content`, `type?`, `visibility?` | Store a custom fact or insight |
| `search_connectors` | `query`, `limit?` | Search indexed content chunks |
| `get_daily_briefing` | `limit?` | Recent workspace activity |
| `find_related_knowledge` | `term`, `limit?` | Semantic search for related concepts |
| `get_expertise_profile` | `team_id?` | Workspace knowledge composition |
| `trace_decision` | `decision_id` | Trace a decision's graph neighborhood |
| `get_team_members` | `team_id?` | (Requires Astrivya Cloud API) |
| `get_team_analytics` | `team_id?` | (Requires Astrivya Cloud API) |
| `list_notifications` | `unread?`, `type?`, `limit?` | (Requires Astrivya Cloud API) |
| `mark_notification_read` | `notification_id?` | (Requires Astrivya Cloud API) |
| `check_credits` | — | Live credit balance, lifetime usage, recent transactions (cloud; fails gracefully offline) |
| `get_context_digest` | `limit?` | Compact pre-digested context for session start (prose) |
| `get_workspace_updates` | `since?`, `limit?` | Knowledge-graph changes since a timestamp (delta) |
| `identify_agent` | `name?`, `model?`, `provider?`, `session?`, `cwd?`, `project?` | Register this session on the Agent Mesh roster |
| `agent_message` | `text`, `to?`, `type?`, `thread_id?`, `in_reply_to?`, `context?`, `urgency?` | Send a message to other agents (A2A) |
| `mesh_read` | `limit?`, `since?`, `agent?`, `type?` | Read the Agent Mesh feed (typed/threaded messages) |

> Cloud-requiring tools gracefully fall back to local AKG stats when the cloud API is unavailable.

## Resources

| URI | Description |
|-----|-------------|
| `astrivya://team/active/knowledge` | Workspace metadata |
| `astrivya://user/active/memories` | Personal memory summary |
| `astrivya://briefing/today` | Recent activity |
| `astrivya://org/knowledge-graph` | All nodes in the graph |

## Environment

| Variable | Description |
|----------|-------------|
| `ASTRIVYA_WORKSPACE_PATH` | Workspace root (default: `cwd`) |
| `ASTRIVYA_TOKEN` | Cloud API token (optional, for sync) |
| `ASTRIVYA_SYNC_KEY` | Sync API key (optional) |
| `ASTRIVYA_CLOUD_URL` | Cloud API URL (optional)      |

## Telemetry

The MCP server sends **anonymous, opt-out** usage stats (server starts/stops,
session start/end, tool names, client name, and a random install id) to PostHog
so we can improve the product. **No code, paths, arguments, query content,
tokens, or any other sensitive data is ever collected.** Tool calls are sampled
at most once per session per tool.

- You'll see a one-time notice on stderr at startup.
- Disable with `ASTRIVYA_TELEMETRY=off` or `NO_TELEMETRY=1`.
- Telemetry is automatically disabled in CI environments.

## License

Apache 2.0
