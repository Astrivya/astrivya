# Astrivya Quick Start

## 5 minutes to a working knowledge graph

### 1. Install

```sh
npm install @astrivya/akg-core
```

### 2. Initialize

```typescript
// index.mjs
import { createAkg } from "@astrivya/akg-core";

const ctx = await createAkg("./my-project");
console.log("AKG ready at ./.astrivya/akg.db");
```

### 3. Add knowledge

```typescript
const now = Date.now();

// Nodes — anything you want to remember
await ctx.storage.upsertNode({
  id: "file:src/api/auth.ts",
  label: "auth.ts",
  type: "file",
  sourceFile: "src/api/auth.ts",
  createdAt: now,
  updatedAt: now,
});

await ctx.storage.upsertNode({
  id: "adr:jwt-auth",
  label: "JWT Authentication",
  type: "adr",
  content: "Use JWT with refresh tokens for API authentication. Tokens expire in 15 minutes, refresh tokens in 7 days.",
  sourceFile: "docs/adr/002-auth.md",
  createdAt: now,
  updatedAt: now,
});

// Edges — relationships between nodes
await ctx.storage.addEdge({
  source: "adr:jwt-auth",
  target: "file:src/api/auth.ts",
  relation: "references",
  weight: 1.0,
});
```

### 4. Search

```typescript
// Natural language query
const results = await ctx.query.retrieve("How does authentication work?", 5);

console.log(results.map(r => ({
  file: r.filePath,
  content: r.content?.slice(0, 100),
  score: r.score,
  source: r.source, // "fts" | "semantic" | "graph"
})));
```

### 5. Traverse

```typescript
import { GraphTraversal } from "@astrivya/akg-core";

const traversal = new GraphTraversal(ctx.storage);

// Find paths
const path = traversal.shortestPath("adr:jwt-auth", "file:src/api/auth.ts");

// Check impact
import { ImpactAnalyzer } from "@astrivya/akg-core";
const impact = new ImpactAnalyzer(ctx.storage);
const report = impact.analyzeRemoval("adr:jwt-auth");
```

### 6. Connect to MCP (for AI agents)

```sh
npm install -g @astrivya/mcp-server

# In your project directory:
astrivya-mcp
```

Then add to Claude Desktop config:

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

### 7. Use the CLI

```sh
npm install -g @astrivya/cli

astrivya init        # Initialize workspace
astrivya akg init    # Create AKG database
astrivya status      # See graph stats + MCP session summary
astrivya mcp         # See what the MCP server has been doing in this workspace
astrivya akg query "auth"  # Search the graph
```

## See your MCP sessions

Every MCP server run in a workspace journals its events to
`.astrivya/mcp/events.ndjson`. Inspect it anytime:

```sh
astrivya mcp        # sessions, tool calls, errors
astrivya mcp log    # recent server start/stop, session, and tool events
astrivya mcp --json # machine-readable summary
```

## What's next?

- **Index your codebase** — use `@astrivya/akg-indexer` to parse ADRs, agent logs, and TODOs
- **Build custom queries** — combine keyword + semantic + graph search with `AkgQuery`
- **Sync between devices** — use `exportGraph()` / `importGraph()` for last-write-wins merge
- **Visualize** — run `astrivya atlas` for WebGL graph rendering

## Want More? Install the VS Code Extension

The CLI and MCP server give you powerful knowledge graph features, but the
VS Code extension adds:

- **Sidebar chat** with team context awareness
- **Auto-context injection** — relevant memories surface as you code
- **Daily briefings** from your connected tools
- **Team features** — share context across your organization
- **One-click setup** — no environment variables needed

[Get it on the Marketplace →](https://marketplace.visualstudio.com/items?itemName=astrivya.astrivya-extension)

> Requires an Astrivya account (free tier available).
> All OSS features remain free and fully functional without the extension.

## Need help?

- [API Reference](akg-core-api.md)
- [Architecture](ARCHITECTURE.md)
- [GitHub Issues](https://github.com/astrivya/astrivya/issues)
