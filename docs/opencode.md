# Astrivya MCP in OpenCode

Add the Astrivya knowledge graph to OpenCode.

## Setup

Edit `~/.config/opencode/opencode.json` (the **global** OpenCode config) or your
project's `opencode.json`:

```json
{
  "mcp": {
    "astrivya": {
      "type": "local",
      "command": ["npx", "-y", "@astrivya/mcp-server"],
      "enabled": true
    }
  }
}
```

The quickest way is to let the CLI do it for you — it detects OpenCode (and the
other supported agents) and writes the entry to the global config:

```sh
astrivya setup --detect
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ASTRIVYA_WORKSPACE_PATH` | Workspace root (default: cwd) |
| `ASTRIVYA_TOKEN` | Optional token for cloud sync features |

## Verify It Is Working

After restarting OpenCode, check that the server has actually run in your
workspace:

```sh
astrivya mcp             # sessions, tool calls, errors for this workspace
astrivya mcp log         # recent journal events (server start / stop, sessions, tools)
astrivya mcp install     # add the Astrivya entry to every detected agent config
astrivya mcp uninstall   # remove the Astrivya entry from every detected agent config
astrivya doctor          # full health check, including the MCP session journal
```

The server journals every event to `.astrivya/mcp/events.ndjson` in your
workspace. From inside a session, an agent can also call the `get_mcp_status`
tool to see the server's own counters.

## Usage

Ask your agent to search the knowledge graph or log decisions. It will use the
Astrivya MCP tools automatically — 15 built-in tools for reading and writing the
knowledge graph, team context, briefings, and decisions.