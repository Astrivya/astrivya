# Contributing to Astrivya

We love contributions! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/astrivya/astrivya.git
cd astrivya
npm install
npm run build:all
```

## Project Structure

```
astrivya/
├── packages/
│   ├── akg-core/        # Core knowledge graph engine
│   ├── akg-indexer/     # File indexer
│   ├── mcp-server/      # MCP server
│   ├── cli/             # CLI
│   ├── plugin-api/      # Plugin contracts
│   ├── plugin-runtime/  # Plugin runtime
│   └── atlas/           # WebGL visualizer (demo)
├── docs/                # Documentation
└── package.json         # Workspace root
```

## Pull Request Process

1. Fork the repo and create a feature branch
2. Add tests for your changes
3. Run `npm run typecheck && npm run build:all && npm test`
4. Open a PR with a clear description of what you changed and why
5. If you haven't before, agree to the [Contributor License Agreement](CLA.md) —
   comment on your PR with `I agree to the [Astrivya CLA] for this and all
   future contributions.` A maintainer will label it `cla-signed`.

## Code Guidelines

- Use TypeScript, strict mode
- No runtime dependencies outside sql.js for core
- MCP server can depend on zod + @modelcontextprotocol/sdk
- 100% of public API surface must have JSDoc-style comments

## License

By contributing you agree to the terms of the [Contributor License
Agreement](CLA.md). The Project is released under Apache 2.0, with some
enterprise/cloud packages additionally offered under FSL-1.1-ALv2 (see
[`CLA.md`](CLA.md) and [`LICENSE`](LICENSE) for details).
