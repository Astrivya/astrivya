# Astrivya MCP in Claude Code

Add the Astrivya knowledge graph to Claude Code (the CLI agent).

## Setup

Run this in your terminal to register the MCP server:

```sh
claude mcp add astrivya -e "npx -y @astrivya/mcp-server"
```

Or add to `~/.claude/settings.json`:

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

## Available Tools

Claude Code gains 15 tools — search memories, log decisions, trace decisions, check the MCP server's own status, query workspace context, and more. See the [MCP server README](../packages/mcp-server/README.md#tools) for the full list.
