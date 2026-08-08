# @astrivya/akg-core API Reference

`@astrivya/akg-core` is an embeddable knowledge graph engine backed by SQLite
(sql.js). Storage, query, traversal, and impact methods are **synchronous**;
only initialization and embedding-backed retrieval are async.

## Entry point

### `createAkg(workspacePath): Promise<AkgContext>`

One-shot initialization. Creates or opens `<workspacePath>/.astrivya/akg.db`
and returns all services bound to it.

```typescript
const ctx = await createAkg("./my-project");
ctx.storage;   // AkgStorage
ctx.query;     // AkgQuery
ctx.traversal; // GraphTraversal
ctx.impact;    // ImpactAnalyzer
```

Lower-level factories: `createStorage(path)`, `createQuery(storage, path)`,
`createTraversal(storage)`, `createImpactAnalyzer(storage)`, and
`withStorage(storage, fn)` for error-wrapped operations.

## AkgStorage

| Method | Returns | Description |
|--------|---------|-------------|
| `init(workspacePath)` | `Promise<void>` | Open or create the database, apply migrations |
| `upsertNode(node)` | `void` | Insert or update a node by `id` |
| `addEdge(edge)` | `void` | Insert a directed edge (auto-creates stub nodes) |
| `upsertChunk(chunk)` | `void` | Index a content chunk |
| `upsertCommunity(community)` | `void` | Insert or update a community |
| `addPerson(person)` | `void` | Insert a person record |
| `addAdrLink(adrNodeId, codeNodeId)` | `void` | Link an ADR node to a code node |
| `getAdrLinks(adrNodeId)` | `string[]` | Code node IDs linked to an ADR |
| `getNode(id)` | `AkgNode \| null` | Look up a node by ID |
| `getNeighbors(id)` | `{ node; relation; direction }[]` | In/out neighbors with relation |
| `deleteFileNodes(filePath)` | `void` | Remove all nodes for a file |
| `getStats()` | `object` | Aggregate graph statistics |
| `exportGraph()` | `SyncGraph` | Serialize the full graph for sync |
| `importGraph(data)` | `{ merged; conflicts }` | Import a serialized graph (last-write-wins) |
| `runQuery(sql, params)` | `any[]` | Execute raw SQL (advanced use) |
| `saveToDisk()` / `close()` | `void` | Flush and close the database |

## AkgQuery

| Method | Returns | Description |
|--------|---------|-------------|
| `retrieve(query, limit?)` | `Promise<RetrievalResult[]>` | Keyword + semantic + graph search fused by intent |
| `classifyQuery(query)` | `QueryIntent` | Determine intent weights for a query |
| `buildContext(query, results)` | `string` | Format results as an LLM context block |

## GraphTraversal

| Method | Returns | Description |
|--------|---------|-------------|
| `shortestPath(fromId, toId)` | `PathResult \| null` | Shortest path (Dijkstra) |
| `dependencies(nodeId, transitive?)` | `AkgNode[]` | Nodes a node depends on |
| `dependents(nodeId, transitive?)` | `AkgNode[]` | Nodes that depend on a node |
| `topologicalSort(relationFilter?, nodeTypeFilter?)` | `TopoSortResult` | Kahn topological sort with cycle detection |

## ImpactAnalyzer

| Method | Returns | Description |
|--------|---------|-------------|
| `analyzeRemoval(nodeId)` | `ImpactReport \| null` | Direct/transitive dependents + risk score |
| `criticalityRanking(limit?)` | `{ node; score }[]` | Rank nodes by dependents count |
| `findCycles(maxLength?)` | `{ path: string[] }[]` | Detect circular dependency loops |

## RelationshipEngine

Extracts `AstRelation` objects from TypeScript ASTs
(`parseTypeScriptAST(filePath, content)`) and git history
(`analyzeGitHistory(workspacePath, filePath)`), then upserts nodes and edges
for file/function/class/interface/dependency relationships.

## Sync (last-write-wins merge)

| Function | Returns | Description |
|----------|---------|-------------|
| `mergeNode(local, remote)` | `AkgNode` | Newer version wins (id tie-breaker) |
| `mergeChunks(local, remote)` | `AkgChunk[]` | Merge chunk sets, newer wins |
| `mergeEdges(local, remote)` | `AkgEdge[]` | Dedupe by source+target+relation, higher weight wins |
| `mergeGraphs(local, remote)` | `SyncGraph` | Combine nodes, edges, and chunks |

## Error classes

| Class | Code | When |
|-------|------|------|
| `AkgError` | `AKG_ERR` | Base error |
| `StorageError` | `STORAGE_ERR` | Database I/O or schema failure |
| `QueryError` | `QUERY_ERR` | Invalid query |
| `TraversalError` | `TRAVERSAL_ERR` | Graph traversal failure |
| `MergeError` | `MERGE_ERR` | Sync conflict |
| `NotFoundError` | `NOT_FOUND` | Entity not found |
| `ValidationError` | `VALIDATION_ERR` | Invalid input |

## Types

`AkgNode`, `AkgEdge`, `AkgChunk`, `AkgCommunity`, `NodeType`, `RelationType`,
`QueryIntent`, `RetrievalResult`, `SyncGraph`, and the config/credits types are
re-exported from the package root.
