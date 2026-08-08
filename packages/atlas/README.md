# @astrivya/atlas

**WebGL knowledge graph visualizer** — explore your Astrivya AKG in 3D.

Atlas renders your local knowledge graph with four layout modes (force-directed, circular, hierarchical, radial) using PixiJS 8 + d3-force + React.

> ⚠️ **Pre-alpha**: Atlas has been extracted and built for the first time. Some features may be incomplete.

## Quick Start

```sh
cd packages/atlas
npm install
npm run dev     # Development server at http://localhost:4200
npm run build   # Production build → dist/
```

## Features

- **4 layout modes**: Force-directed, Circular, Hierarchical, Radial
- **Real-time search**: Type to find nodes, click to inspect
- **Type filtering**: Toggle visibility by node type
- **Fly-to animation**: Click any node to center and zoom
- **Dark theme**: Professional color palette by node type

## Connecting to AKG

Atlas reads from the local AKG database (`<workspace>/.astrivya/akg.db`). It's configured via the API client:

```
packages/atlas/src/api/akg-client.ts
```

Set `ASTRIVYA_WORKSPACE_PATH` or modify the client to point to your workspace.

## Tech Stack

- React 18 + TypeScript
- PixiJS 8 (WebGL rendering)
- d3-force (layout simulation)

## License

Apache 2.0
