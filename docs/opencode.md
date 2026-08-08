# Astrivya MCP in OpenCode

Add the Astrivya knowledge graph to OpenCode.

## Setup

Edit `~/.config/opencode/opencode.json` or your project's `.opencode/config.json`:

```json
{
  "mcp": {
    "@astrivya/mcp-server": {
      "type": "local",
      "command": ["npx", "-y", "@astrivya/mcp-server"],
      "enabled": true
    }
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ASTRIVYA_WORKSPACE_PATH` | Workspace root (default: cwd) |

## Usage

After restarting OpenCode, ask your agent to search the knowledge graph or log decisions. It will use the Astrivya MCP tools automatically.
