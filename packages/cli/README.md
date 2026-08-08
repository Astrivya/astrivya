# @astrivya/cli

**Local knowledge graph CLI** for AI coding agents. Initialize, index, search, and manage your workspace knowledge graph — all local, no cloud required.

```sh
npm install -g @astrivya/cli
```

## Commands

| Command | Description |
|---------|-------------|
| `astrivya init` | Initialize knowledge graph database in the current workspace |
| `astrivya akg <subcommand>` | AKG management (init, status, search, query, export, import) |
| `astrivya config` | View or edit configuration |
| `astrivya status` | Overview of workspace knowledge graph status |
| `astrivya sync` | Sync graphs between workspaces (local merge) |
| `astrivya mcp-server` | Start the MCP server (stdio or HTTP) |
| `astrivya setup` | Guided setup assistant |
| `astrivya doctor` | Run workspace diagnostics |
| `astrivya update` | Check for CLI updates |
| `astrivya hooks install` | Install git hooks for auto-indexing on commit/merge |
| `astrivya local` | Manage local AI runtime (ONNX, Ollama) |
| `astrivya runtime` | Manage inference runtime selection and benchmarking |
| `astrivya atlas` | Launch the WebGL knowledge graph visualizer |

Run without arguments to start the interactive TUI.

### akg subcommands

```
astrivya akg init             Initialize the local AKG database
astrivya akg status           Show AKG statistics
astrivya akg search <query>   Search the knowledge graph
astrivya akg query <intent>   Intent-based query
astrivya akg export           Export the graph to JSON
astrivya akg import <file>    Import a graph from JSON
astrivya akg sync             Sync with a remote (if configured)
```

## Quick Start

```sh
cd my-project
astrivya init
astrivya akg init
astrivya status
```

## Cloud, Plugins & Updates

The CLI is fully functional offline and locally. Optional cloud features (team
sync, premium plugins, credits) are **server-authoritative**:

- Plugin artifacts are downloaded from Astrivya Cloud, gated by a license key and
  verified against the manifest's SHA-256. Integrity verification is **not DRM** —
  the entitlement check happens server-side, and installed plugins run without a
  license re-check on every load.
- Updates are checked at most once per day and shown once per version. Opt out
  with `--no-update-check`, `NO_UPDATE_NOTIFIER`, `CI`, or `astrivya update disable`.

## License

Apache 2.0 (`packages/cli`). This package is the open client for Astrivya's
commercial cloud service; paid plugins are separate, license-gated artifacts
served from Astrivya Cloud and are not part of this package.
