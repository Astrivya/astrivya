# Astrivya MCP in Codex CLI

Add the Astrivya knowledge graph to Codex CLI (OpenAI's coding agent).

## Setup

Add to your Codex CLI config (typically `~/.codex/config.json`):

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

Or set via environment:

```sh
CODEX_MCP_SERVERS='{"astrivya":{"command":"npx","args":["-y","@astrivya/mcp-server"]}}' codex
```

## Usage

Codex CLI will have persistent access to your workspace knowledge graph — search past decisions, log new ones, and trace relationships between code and design artifacts.
