# Astrivya OSS — Agent Context

## Repository

This is the **public** OSS monorepo. All packages live in `packages/`.

**History (2026-08-08):** the repo was moved from `amruthjakku/astrivya-oss`
(legacy, untouched) to a fresh **`github.com/astrivya/astrivya`** with a single
squashed commit on branch `main`. The npm registry already holds the initial
`0.1.0` of all six packages (published via `scripts/publish-bootstrap.sh`).
CI/release-please setup: `NPM_TOKEN` secret set on the repo, org Actions spend
limit is `$0`. `ci` + `release` workflows listen on both `master` and `main`.

## Structure

```
packages/akg-core/       # Core knowledge graph engine (SQLite + keyword/semantic + graph)
packages/akg-indexer/    # File indexer: ADRs, agent logs, todos, embeddings
packages/mcp-server/     # MCP server: 14 tools for MCP clients
packages/cli/            # CLI: init, index, search, manage, TUI (40 commands)
packages/atlas/          # WebGL graph visualizer (demo, private)
```

## Cloud Server (Private)

The cloud server lives in a separate sibling repo:

```
../astrivya-infra/       # git@github.com:astrivya/astrivya-infra.git
├── cloud/               # Hono + Supabase backend (port 3000)
└── mcp-gateway/         # Tenant-isolated MCP proxy (port 3015)
```

Start both repos together:
```bash
bash scripts/dev.sh
```

## Private Registry (Verdaccio)

Proprietary `@astrivya/*` packages (cloud, cloud-cli, cloud-mcp, cloud-api,
cron-worker, infra-shared, mcp-gateway — all `0.1.1`, license `FSL-1.1-ALv2`)
are published on a self-hosted **Verdaccio** registry at
**`https://npm.astrivya.ai`** (Caddy route → `verdaccio:4873` on the VM; see
§20 in ops-findings). All 7 are available on the registry as `0.1.1` (the
original `0.1.0` uploads are superseded by `latest`).

- **Guard:** every infra package carries `publishConfig: { access: "restricted", registry: "https://npm.astrivya.ai/" }`. Do **not** set `private: true` — npm refuses to publish `private` packages even to the private registry.
- **@astrivya/* never proxies to public npm** in the verzaccio config (`proxy: none`); scope reads require auth.
- **Publish auth gotcha:** use the legacy `//npm.astrivya.ai/:_auth=<base64 user:pass>` key (Basic); Verdaccio v5 rejects npm's default `_authToken` (Bearer) with 401.
- Publish on the **VM** (creds live only in its `.env`): pack tarballs locally → scp to `/tmp` → publish with a temp `.npmrc` built from `VERDACCIO_ADMIN_USER`/`VERDACCIO_ADMIN_PASSWORD`. Never print the password.
- All 7 packages ship `dist` (+ `LICENSE`, `README.md` via `files`) **except `cron-worker`**, which is a Cloudflare Workers source package (no `dist`/`main`; wrangler compiles from `src` at deploy time). Do **not** add a `files`/`main` to it.

## Cross-Repo Dev

- OSS packages call cloud via HTTP, not package imports.
- Env var `ASTRIVYA_CLOUD_URL=http://localhost:3000` wires them together.
- `scripts/dev.sh` starts both servers from the sibling repo, sets env vars.

## npm Published Packages

| Package | npm |
|---------|-----|
| `@astrivya/akg-core` | Core engine |
| `@astrivya/akg-indexer` | File indexer |
| `@astrivya/akg-core` | Core engine |
| `@astrivya/akg-indexer` | File indexer |
| `@astrivya/mcp-server` | MCP server |
| `@astrivya/cli` | CLI |

Monorepo release automation is handled by **release-please** (`.github/release-please-config.json` + `.release-please-manifest.json`), which auto-bumps versions from Conventional Commits and opens a single "Release" PR. Merging it auto-publishes the changed packages to npm in dependency order (`akg-core → plugin-api → plugin-runtime → akg-indexer → mcp-server → cli`). The `atlas` app is private and excluded from releases.

- **Unified versions:** all six packages share one version (release-please `linked-versions` group "astrivya"). Any change bumps every package to the same number and they release together.
- Every release is driven by commit messages: `fix:` → patch, `feat:` → minor, `BREAKING CHANGE`/`!` → major.
- Before 1.0.0, a `BREAKING CHANGE` on a `0.x` package jumps straight to `1.0.0` — keep breaking/feature bumps as `minor` until 1.0 unless a major is intended.
- **Bundled libs:** `@astrivya/akg-core`, `@astrivya/akg-indexer`, `@astrivya/plugin-runtime`, `@astrivya/plugin-api` are bundled into the CLI dist (and the libs the server uses into `mcp-server` dist). So `astrivya update` or `npm i -g @astrivya/mcp-server@latest` ships the newest libs too — no semver-range drift. The pure packages are still published for direct npm consumers.
- **One-time bootstrap only:** the initial `0.1.0` of all six packages must be published before anything is installable — run `npm run release:bootstrap` once. After that, release-please handles all releases (no manual version edits).
- Publishing uses `NPM_TOKEN` (repo is private; no OIDC/provenance).

## CLI Update Experience

- The bundled CLI carries its real version (injected via `tsup` `define` in `packages/cli/tsup.config.ts`; source of truth `src/lib/version.ts`).
- A non-blocking update notifier runs after commands and shows a one-line banner **once per new version**; it never crashes the CLI. Opt-outs: `--no-update-check`, `NO_UPDATE_NOTIFIER`, `CI`, or `astrivya update disable`.
- `astrivya update` checks + installs in one step, auto-detecting the install method (npm/pnpm/yarn/bun/local). Override with `ASTRIVYA_UPDATE_MANAGER`.

## mcp-server Update Notifier

- `@astrivya/mcp-server` checks the npm registry once per day at startup and prints a one-line banner to **stderr** (stdout is the MCP stdio protocol channel). Non-blocking, never crashes.
- Version injected via tsup `define` (source of truth `src/lib/version.ts`). Opt-outs: `CI`, `NO_UPDATE_NOTIFIER`, `ASTRIVYA_MCP_NO_UPDATE_CHECK`.
- Cache lives at `envPaths("astrivya-mcp").cache/update.json`; notifies at most once per version.

## Key Env Vars

| Var | Used By | Description |
|-----|---------|-------------|
| `ASTRIVYA_CLOUD_URL` | `mcp-server` api.ts | Cloud server endpoint |
| `ASTRIVYA_TOKEN` | `mcp-server`, `cli` | Auth token for cloud features |
| `ASTRIVYA_BASE_URL` | `mcp-server`, `cli` | Fallback API URL (default: https://astrivya.ai) |

## Conventions

- All DB queries use explicit columns: `.select("id, name, created_at")` never `.select("*")`
- AI SDK: Uses `openai` package directly, NOT `ai` or `@ai-sdk/*`
- Public API surfaces must have JSDoc
- TypeScript strict mode required
