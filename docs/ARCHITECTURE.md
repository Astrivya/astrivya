# Astrivya Architecture

Astrivya is a **local-first knowledge graph engine** for AI coding agents. It runs embedded in your process (no server), stores everything in SQLite, and exposes the graph through a simple API or MCP.

## Core Design

```
┌─────────────────────┐
│  CLI / MCP / API    │  ← Interfaces
├─────────────────────┤
│  AKG Indexer        │  ← File watchers, parsers
├─────────────────────┤
│  AKG Core           │  ← Storage, Query, Traversal, Impact, Merge
├─────────────────────┤
│  SQLite (sql.js)    │  ← Persistence layer
└─────────────────────┘
```

## Storage Layer

- On-disk SQLite database (via sql.js, compiled to WebAssembly)
- Keyword full-text search over content chunks
- 384-dim float32 vectors stored as BLOBs for cosine similarity search
- Graph edges stored in a junction table with relation types

## Query Layer

- **Literal search**: Keyword substring matching
- **Semantic search**: Cosine similarity over 384-dim embeddings
- **Graph queries**: BFS/DFS traversal, shortest path, topological sort
- **Intent queries**: High-level queries (find_related, find_dependencies, find_impact)

## Indexer Layer

Three built-in parsers:
1. **ADR Parser** — Architecture Decision Records with YAML frontmatter
2. **Agent Parser** — Agent conversation/context logs
3. **Todo Parser** — TODO/FIXME/HACK comments

Extensible via plugin interface.

## Packages

| Package | Responsibility |
|---------|---------------|
| `akg-core` | Storage, query, traversal, impact analysis, sync/merge |
| `akg-indexer` | File parsing, chunking, embedding |
| `mcp-server` | Model Context Protocol interface (15 tools) |
| `cli` | Terminal interface for graph management |
| `atlas` | WebGL visualization (demo app) |
