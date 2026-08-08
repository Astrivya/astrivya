# Astrivya MCP in Cursor

Add the Astrivya knowledge graph to Cursor IDE via MCP.

## Setup

1. Open Cursor Settings → Features → MCP Servers
2. Click **Add New MCP Server**
3. Fill in:

| Field | Value |
|-------|-------|
| Name | `astrivya` |
| Type | `command` |
| Command | `npx -y @astrivya/mcp-server` |

Or add to `.cursor/mcp.json` in your project root:

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

## Usage

Cursor's AI will now be able to search, store, and query your local knowledge graph across sessions.
