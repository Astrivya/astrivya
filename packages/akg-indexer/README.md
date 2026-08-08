# @astrivya/akg-indexer

**Knowledge graph indexer** — parse ADRs, agent logs, and TODO files into the Astrivya Knowledge Graph.

```sh
npm install @astrivya/akg-indexer
```

Requires `@astrivya/akg-core` as a peer dependency.

## Usage

```typescript
import { AdrParser, AgentParser, TodoParser, AkgIndexer } from "@astrivya/akg-indexer";
import { AkgStorage } from "@astrivya/akg-core";

const storage = new AkgStorage();
await storage.init("./my-project");

// Index all supported files in a workspace
const indexer = new AkgIndexer(storage, "./my-project");
indexer.indexAll();

// Or use individual parsers:
const adr = new AdrParser(storage, "./my-project");
await adr.parseAndIndexADR("docs/adr/001-architecture.md", "...markdown content...");

const agent = new AgentParser(storage);
agent.parseAgentActivity("./my-project");

const todo = new TodoParser(storage);
todo.parseWorkspaceTodos("./my-project");
```

## Parsers

### AdrParser
Parses Architecture Decision Records (Markdown files with YAML frontmatter). Extracts title, status, context, decision, and consequences.

### AgentParser
Reads agent conversation logs from the local AI agent's brain directory (`.gemini/antigravity-ide/brain/`). Maps tool calls to graph nodes and edges.

### TodoParser
Scans workspace for `todo.md`, `TODO.md`, `tasks.md`, and `TASKS.md` files. Creates task nodes and links them to referenced files.

### Embedder (`AkgEmbedder`)
Generates 384-dim embeddings using ONNX models (requires `@xenova/transformers`). Used for semantic search.

> **Optional feature, opt-in.** To keep the published package dependency-light, the ONNX embedding stack is **not** installed automatically. To enable embeddings, the consumer installs the peer deps manually:

```bash
npm i -D @xenova/transformers onnxruntime-node
```

Without them, `AkgEmbedder.init()` throws a clear message instructing you to install the deps; the rest of the indexer works normally.

```typescript
import { AkgEmbedder } from "@astrivya/akg-indexer";

const embedder = new AkgEmbedder();
await embedder.init("./models");
const vector = await embedder.embed("Your text content here");
// Returns Float64Array(384)
```

## License

Apache 2.0
