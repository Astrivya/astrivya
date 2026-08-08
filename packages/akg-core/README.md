# @astrivya/akg-core

**Embeddable knowledge graph engine** — SQLite-embedded, keyword full-text search, optional 384-dim vector embeddings, graph traversal, impact analysis, and last-write-wins sync/merge. Zero external services, one file per workspace.

```sh
npm install @astrivya/akg-core
```

## Quick Start

```typescript
import { createAkg } from "@astrivya/akg-core";

// Initialize in any directory
const ctx = await createAkg("./my-project");

// Insert nodes (files, decisions, concepts)
await ctx.storage.upsertNode({
  id: "adr:001",
  label: "Use React for frontend",
  type: "adr",
  content: "Decision to adopt React 18 with TypeScript for the SPA.",
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// Insert edges (relationships)
await ctx.storage.addEdge({
  source: "adr:001",
  target: "file:package.json",
  relation: "references",
  weight: 1,
});

// Search
const results = await ctx.query.retrieve("React frontend", 5);

// Traverse graph
const path = ctx.traversal.shortestPath("adr:001", "file:package.json");

// Analyze impact
const report = ctx.impact.analyzeRemoval("adr:001");
```

## API Reference

### `createAkg(workspacePath): Promise<AkgContext>`
One-shot initialization. Creates/opens the `.astrivya/akg.db` SQLite database and returns all services.

### `AkgStorage`

| Method | Description |
|--------|-------------|
| `init(workspacePath)` | Open or create the database |
| `upsertNode(node)` | Insert or update a node |
| `getNode(id)` | Look up a node by ID |
| `deleteFileNodes(filePath)` | Remove all nodes associated with a file |
| `getNeighbors(id)` | Get immediate neighbor nodes |
| `addEdge(edge)` | Insert a directed edge |
| `upsertChunk(chunk)` | Index a content chunk (keyword + optional embedding) |
| `getStats()` | Aggregate graph statistics |
| `exportGraph()` | Serialize the full graph for sync |
| `importGraph(data)` | Import a serialized graph (last-write-wins merge) |
| `close()` | Flush and close the database |
| `runQuery(sql, params)` | Execute raw SQL (advanced use) |

### `AkgQuery`

| Method | Description |
|--------|-------------|
| `retrieve(query, limit)` | Multi-strategy search (keyword + semantic + graph) |
| `classifyQuery(query)` | Determine search intent weights |
| `buildContext(query, results)` | Format results as LLM context block |

### `GraphTraversal`

| Method | Description |
|--------|-------------|
| `shortestPath(from, to)` | Shortest path between two nodes |
| `topologicalSort(...)` | Topological sort with cycle detection |
| `dependencies(id, transitive?)` | Nodes a node depends on |
| `dependents(id, transitive?)` | Nodes that depend on a node |

### `ImpactAnalyzer`

| Method | Description |
|--------|-------------|
| `analyzeRemoval(nodeId)` | Impact report with risk score for removing a node |
| `criticalityRanking(limit?)` | Rank nodes by how many depend on them |
| `findCycles(maxLength?)` | Detect circular dependency loops |

### Sync (Last-Write-Wins Merge)

| Function | Description |
|----------|-------------|
| `mergeNode(local, remote)` | Merge two versions of a node |
| `mergeChunks(local, remote)` | Merge chunk sets |
| `mergeEdges(local, remote)` | Merge edge sets |
| `mergeGraphs(local, remote)` | Merge full graphs |

### Error Classes

| Class | Code | When |
|-------|------|------|
| `AkgError` | `AKG_ERR` | Base error |
| `StorageError` | `STORAGE_ERR` | Database I/O or schema failure |
| `QueryError` | `QUERY_ERR` | Invalid query |
| `TraversalError` | `TRAVERSAL_ERR` | Graph traversal failure |
| `MergeError` | `MERGE_ERR` | Sync conflict |
| `NotFoundError` | `NOT_FOUND` | Entity not found |
| `ValidationError` | `VALIDATION_ERR` | Invalid input |

### Types

```typescript
type NodeType = "file" | "function" | "class" | "interface" | "adr" | "task"
  | "agent" | "agent_action" | "dependency" | "person" | "community" | "workspace";

type RelationType = "depends_on" | "imports" | "calls" | "implements" | "extends"
  | "contains" | "references" | "documents" | "generated";

interface AkgNode { id, label, type, content?, sourceFile?, metadata?,
  createdAt, updatedAt, ... }

interface AkgEdge { source, target, relation, weight?,
  confidence?, extractionMethod? }

interface AkgChunk { id?, nodeId, filePath, content, startLine?, endLine?,
  embedding? }

interface AkgContext { storage, query, traversal, impact }
```

## How It Works

```
┌─────────────┐  SQLite Database (.astrivya/akg.db)
│   Nodes     │  ├── nodes (graph vertices)
│   Edges     │  ├── edges (directed relations)
│   Chunks    │  ├── chunks (keyword-indexed content)
│   Vectors   │  ├── embeddings (384-dim float32)
└─────────────┘  └── communities, persons, metadata
```

The database is a single file — copy it, sync it, commit it. No server, no API keys, no cloud dependency.

## License

Apache 2.0
