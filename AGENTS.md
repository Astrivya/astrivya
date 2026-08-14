# Astrivya OSS — Agent Context

## Repository

This is the **public** OSS monorepo. All packages live in `packages/`.

**History (2026-08-08):** the repo was moved from `amruthjakku/astrivya-oss`
(legacy, untouched) to a fresh **`github.com/astrivya/astrivya`** with a single
squashed commit on branch `main`. The npm registry already holds the initial
`0.1.0` of all six packages (published via `scripts/publish-bootstrap.sh`).
CI/release-please setup: `NPM_TOKEN` secret set on the repo, org Actions spend
limit is `$0`. `ci` + `release` workflows listen on both `master` and `main`.

**Git remotes (canonical):** `origin` is `https://github.com/Astrivya/astrivya.git`
and `main` tracks `origin/main`. The old `amruthjakku/astrivya-oss` fork is
retained as the `legacy` remote only — never push to it. `main` is a
protected branch on GitHub: all changes land via PRs against `Astrivya/astrivya`
(`git push origin <branch>` → open PR → merge), never by direct push to `main`.

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
../astrivya-infra/       # git@github.com:amruthjakku/astrivya-infra.git (private; NOT under the astrivya org)
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
- **Publish (preferred, CI):** `.github/workflows/publish-private.yml` in `astrivya-infra` (live 2026-08-14, commit `3c0664e`) — tag `cloud-<pkg>@<version>` (e.g. `cloud-api@0.2.0`) or manual dispatch (`all` / any of the 7). It builds first (packages ship `dist/` only, NO prepack hook), preflights auth, publishes cloud-api before cloud-cli/cloud-mcp (runtime dep), verifies each version resolves post-publish. Requires repo secrets `VERDACCIO_ADMIN_USER` + `VERDACCIO_ADMIN_PASSWORD` (set 2026-08-14).
- **Publish (manual):** `scripts/publish-private.sh [--build] [--env-file <path>] [package-dir ...]` in `astrivya-infra` (idempotent; `--build` runs tsup before packing; auth preflight + post-publish verify built in). The repo is also cloned at `/home/azureuser/astrivya-infra` on the VM (read-only deploy key `astrivya_infra`; pull with `GIT_SSH_COMMAND="ssh -i ~/.ssh/astrivya_infra"`). Creds from `VERDACCIO_ADMIN_USER`/`VERDACCIO_ADMIN_PASSWORD` env or `--env-file /home/azureuser/astrivya/.env`. Never print the password.
- **Auth gotcha:** use the legacy `//npm.astrivya.ai/:_auth=<base64 user:pass>` key (Basic); Verdaccio v5 rejects npm's default `_authToken` (Bearer) with 401. Auth preflight checks `/-/whoami` for the username **in the response body** — whoami returns HTTP 200 even anonymously (body `{}`).
- **Leak guard:** NEVER create a workflow that publishes `@astrivya/cloud*`/`infra-shared`/`mcp-gateway` to public npmjs — the old `publish.yml` (deleted 2026-08-14) leaked `cloud-api`/`cloud-cli`/`cloud-mcp` 0.1.0 to public npm (deprecated there).
- All 7 packages ship `dist` (+ `LICENSE`, `README.md` via `files`) **except `cron-worker`**, which is a Cloudflare Workers source package (no `dist`/`main`; wrangler compiles from `src` at deploy time). Do **not** add a `files`/`main` to it.
- **FSL license keys are the entitlement source** (infra `285e3a7`/`92b5ebc`): a verified `astlk_` key drives the tier used by `plugins/manifest`, `sync`, `briefings`, and `/api/ide/me` (subscriptions are fallback); `/api/ide/me` reads display fields from `profiles` (not `users`) and returns `org.tier` + `license` — the mcp-gateway depends on this to gate Cloud MCP. Do not add `full_name`/`avatar_url` selects against `users`.

## Cross-Repo Dev

- OSS packages call cloud via HTTP, not package imports.
- Env var `ASTRIVYA_CLOUD_URL=http://localhost:3000` wires them together.
- `scripts/dev.sh` starts both servers from the sibling repo, sets env vars.

## Cloud Packages & Plugin Artifacts (2026-08-14)

**Why no cloud packages on public npm:** the 7 proprietary packages (`cloud`,
`cloud-api`, `cloud-cli`, `cloud-mcp`, `cron-worker`, `infra-shared`,
`mcp-gateway` — all `0.1.1`, license `FSL-1.1-ALv2`) live only in the private
`../astrivya-infra/` repo and publish only to the private Verdaccio registry.
The `@astrivya:registry=https://npm.astrivya.ai/` scope mapping exists **only in
the infra repo's `.npmrc`**; the OSS repo maps no scope, so its packages land on
npmjs.org. Verified 2026-08-14: zero `@astrivya/cloud*`/`infra-shared`/
`mcp-gateway` imports in any OSS `package.json` or `.ts` file, and no
`npm.astrivya.ai` references in the published `cli@0.4.0` dist.

**How OSS reaches the cloud (package-free channels):**
- **HTTP:** `syncCall()` in `packages/mcp-server/src/api.ts` → `https://api.astrivya.ai`
  (override `ASTRIVYA_CLOUD_URL`), bearer token from config/env.
- **Runtime plugin artifacts (not npm):** plugin-runtime fetches
  `${ASTRIVYA_CLOUD_URL}/api/plugins/manifest` (`manifest-client.ts`) and downloads
  `cloud-cli`/`cloud-mcp` as `.tgz` artifacts **served by the cloud server**,
  sha256-verified (`plugin-downloader.ts`), installed to `~/.astrivya/plugins/<id>`
  (entry files are root-level `index.js`/`index.mjs` — the installed artifact
  layout differs from the infra repo's `dist/` build). Plugin deps (e.g.
  `@astrivya/cloud-api`) are npm-installed **inside the plugin dir**, resolving
  through the infra repo's private-registry scope.
- **`compatibility` fields are advisory:** `compatibility.{cli,api,runtime}` in
  the local plugin manifest are stored (`plugin-registry.ts`) but **never
  enforced** by `sync()` (`plugin-manager.ts`). Verified: cloud-cli/cloud-mcp
  declare `cli: ">=0.5.0"` yet load and run under `cli@0.4.0` — they import only
  `@astrivya/cloud-api` + `commander` + env vars, no CLI internals.
- **Cloud-command auth:** plugins read `ASTRIVYA_TOKEN`/`ASTRIVYA_API_KEY` from
  the environment (the CLI injects its config via `injectPluginEnv()`). A stale
  token surfaces as `Error: Unauthorized (401) ... Check your token` from the
  plugin's first API call (e.g. `/api/ide/me` for `who`) — refresh with
  `astrivya auth login`.

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
- **Auto-update (2026-08-14)**: at the START of every command the CLI checks the registry (24h throttle, 2.5s fetch timeout) and prompts `Update X → Y now? [y/N]` (30s prompt timeout; TTY only — non-TTY prints the banner). `astrivya config set autoUpdate on` installs silently without prompting; `off` restores banner-only. Never auto-installs `local`/`unknown` installs (source checkouts, npx) or major version jumps (major = banner + explicit `astrivya update`); failed installs back off 24h. The `update` and `mcp-server` commands never trigger it. Logic lives in `src/lib/auto-update.ts` (policy, pure decision `shouldAutoInstall`); `src/lib/update-notifier.ts` stays the pure cache/check layer.
- **Banner-first + forceCheck (2026-08-14)**: the update banner prints BEFORE the prompt is shown (`printBanner()` precedes `askYesNo` in the TTY path), and the preAction hook passes `forceCheck: !thisCommand.parent` — a bare `astrivya`/TUI session start bypasses the 24h throttle so an interactive session always sees the prompt if an update exists (throttle still applies to every subsequent command in the session).
- **Install failure diagnostics (2026-08-14)**: `runInstall` captures the child's stdout/stderr and prints the tail (last 6 lines) on failure — an `Update failed: Command failed: ...` message alone is not diagnosable (npm writes no debug log when it is killed by the 180s install timeout).
- **Update cascade (2026-08-14)**: after ANY successful CLI install (prompt y, silent `on`, or explicit `astrivya update`/`update install`), `runInstall` → `cascadeUpdate(manager)`: (1) detects a standalone global `@astrivya/mcp-server` using the SAME install manager (`npm ls -g` / `pnpm ls -g` / `yarn global list --pattern` / `bun pm ls -g`, stdout contains the package name) and updates it (`npm install -g @astrivya/mcp-server@latest` etc.) — local/unknown managers and missing global installs skip silently (CLI-bundled server rides the CLI update; npx is ephemeral); (2) sets a cascade flag that forces `maybeSyncPlugins({ force: true })` in the postAction hook (bypasses the 24h throttle) so cloud-cli/cloud-mcp plugins update immediately. Cascade is soft-fail: never throws, never blocks exit. akg-core/akg-indexer/plugin-* need nothing — bundled in the CLI dist.
- **Plugin auto-sync (2026-08-14)**: `maybeSyncPlugins` runs after every command (~24h throttle, `plugin-sync.json` in the cache dir, skip when unauthenticated/`--local`/CI); sha256-verified on the plugin-runtime side, only prints when something changed or failed. Best-effort, never crashes.
- **Cloud-command auth (2026-08-14)**: every cloud-touching command goes through `ensureAuth` (`src/lib/auth-guard.ts`): authenticated → proceeds; not → prints "You're not logged in" and on a TTY prompts `Log in now? [y/N]` — yes runs the browser login flow in-process (`runLoginFlow`, extracted from `commands/auth.ts`), no re-exec. Non-TTY/declined → hint + exit 1. Wired into `team create/invite/join` and `credits`; the rest of the fetch-capable commands just print the hint.
- **`auth login` UX (2026-08-14)**: never opens a browser unprompted. Interactive TTY shows a menu — `1) Browser / 2) Paste a token / 3) Cancel` (`parseLoginChoice`; hidden input via `promptHidden` in `src/lib/prompt.ts`). Before opening, `probeOAuthConfig` pre-flights `${baseUrl}/auth/cli` (`redirect: "manual"` + Location check) and warns when the cloud has an empty `client_id` (misconfigured GitHub OAuth) instead of silently opening a broken page. Non-TTY exits with a hint; `--token <t>` validates via `/api/ide/me` and saves (CI/headless); `--provider github|google` passthrough. After any successful login, `warnEnvTokenShadow` warns when a leftover `ASTRIVYA_TOKEN` env var shadows the stored token (the CLI's `getToken()` prefers env) — the stale user-scope var is what caused `401 ... Check your token` on `astrivya who`.
- **Plugin env injection (2026-08-14)**: `injectPluginEnv()` (`src/lib/plugin.ts`) copies the CLI's resolved config (`ASTRIVYA_BASE_URL`, `ASTRIVYA_TOKEN`, `ASTRIVYA_LICENSE_KEY`) into `process.env` BEFORE `loadCommandPlugins()` — plugin packages (`@astrivya/cloud-cli`, `@astrivya/cloud-api`) read auth from the environment and had no other way to see the config-file token; they also used to default to `https://www.astrivya.ai` (marketing site → HTML 404s). Never overrides an existing env var.
- **Exit hygiene (2026-08-14)**: error paths set `process.exitCode = 1; return;` instead of `process.exit(1)` — hard-exiting while undici fetch handles are still closing crashes Node on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in libuv). Exceptions that keep hard exits on purpose: TUI (`tui.ts`, `repl-input.ts`), Ctrl-C handlers (`index-progress.ts`), `entry-guard.ts`, the commander mock in tests.
- A non-blocking update notifier prints a one-line banner **once per new version**; it never crashes the CLI. Opt-outs: `--no-update-check`, `NO_UPDATE_NOTIFIER`, `CI`, or `astrivya update disable`.
- `astrivya update` checks + installs in one step (bypasses the same-major auto-update pin), auto-detecting the install method (npm/pnpm/yarn/bun/local). Override with `ASTRIVYA_UPDATE_MANAGER`.

## mcp-server Update Notifier

- `@astrivya/mcp-server` checks the npm registry once per day at startup and prints a one-line banner to **stderr** (stdout is the MCP stdio protocol channel). Non-blocking, never crashes.

## mcp-server Sessions & Status (2026-08-14)

- **Live session registry**: `status.ts` keeps a per-session `Map` keyed by id (HTTP: the SDK's generated `Mcp-Session-Id`, threaded from `extra.sessionId` in the `CallToolRequestSchema` handler; stdio: `stdio:<pid>`). Each session tracks client (User-Agent for HTTP, `"stdio"` otherwise), mode, started/last-active/ended timestamps, per-session tool counters, and last tool. Sessions idle >30 min are auto-ended (`sweepIdleSessions` runs before every snapshot). Ended sessions stay in the registry (bounded to 40) so "recently ended" views work.
- **HTTP session lifecycle** (`index.ts`): registration happens on the response `finish` via the `Mcp-Session-Id` header (`ensureSession`, no-op when already active); `DELETE` closes the session; follow-up requests `touchSession`. The HTTP server serves `/status` (full snapshot incl. `sessionsList` + per-tool p50/p95) and `/journal?limit=N` (rotated-archive-aware), both with CORS enabled.
- **Per-tool latency**: `recordToolCall(name, ok, { sessionId, durationMs })` feeds a 256-sample ring buffer per tool; `getStatus()` reports `p50Ms`/`p95Ms`/`lastMs`.
- **Journal rotation**: `events.ndjson` rotates to `events.ndjson.1` once it exceeds 5MB; `readJournal` reads archive-then-live so ordering is preserved. Tool/session events carry `session_id`, `client`, `duration_ms`.
- **Surfaces**: `astrivya mcp status` (journal-derived session table; `--live` probes `http://localhost:3001/status` via `ASTRIVYA_MCP_URL`, `--tokens` fetches the cloud credit balance, `--link` shows Atlas, `--json` raw), `astrivya mcp metrics` (Prometheus text; live-first, journal fallback via `--journal`), CLI `status` prints "N active / M total", Atlas `astrivya serve` proxies `/api/mcp/status` + `/api/mcp/journal` and has a Sessions side panel (3s poll while open, active cards + recently ended + per-tool latency). `get_mcp_status` (tool) and the context digest now include the session registry (`mcp.active_sessions`/`total_sessions`).
- **active_file boost** (`search_memories` handler): when the caller passes `active_file`, results whose `filePath` matches are promoted (`+0.25` re-rank before merging cloud nodes) and a note is attached.
- **Journal-mode rendering caveat (2026-08-14, FIXED)**: `astrivya mcp status` (no `--live`) derives sessions from the append-only journal, which conflates (a) legacy pre-session-id `session_start` rows, (b) orphans (process hard-killed → no `session_end`), and (c) healthy sessions. Fix (CLI-only, `packages/cli/src/commands/mcp.ts`): a PID-liveness probe `isPidAlive(pid)` (`process.kill(pid, 0)`, ESRCH→dead, EPERM→alive) classifies each session with no `session_end` as `active` (pid alive) vs `orphan` (pid dead, dimmed); legacy no-`session_id` rows collapse to one summary line `N legacy sessions — X alive / Y orphaned` (`--all` expands); `summarizeMcpJournal.activeSessions` (used by `astrivya status`'s "N active / M total" and `mcp status --json`) uses the same probe so the headline matches reality. `journalSessionRows(events, isAlive)` takes the probe injectable for tests. The journal stays append-only (no synthetic `session_end` writes, no server janitor); the live registry is authoritative. Accepted tradeoff: a recycled PID mislabels at most one row as active (e.g. legacy `pid:28680` = an unrelated `ShellHost.exe`).

- **Auto-update (opt-in, 2026-08-14)**: set `ASTRIVYA_MCP_AUTO_UPDATE=1` to install newer same-major versions in the **background** at startup (`npm install -g @astrivya/mcp-server@latest`, detached). Only for global installs (npm/pnpm/bun global paths); never via npx cache (`_npx`) or local projects. The running process keeps its loaded code — the update takes effect on the next client launch; a `pending` marker in the cache is verified against the running version on the next startup (success/failure is reported, failures back off 24h). Logic in `src/lib/auto-update.ts` (`isGlobalInstall`, `verifyPendingUpdate`).
- Version injected via tsup `define` (source of truth `src/lib/version.ts`). Opt-outs: `CI`, `NO_UPDATE_NOTIFIER`, `ASTRIVYA_MCP_NO_UPDATE_CHECK`.
- Cache lives at `envPaths("astrivya-mcp").cache/update.json`; notifies at most once per version.

## Embeddings, Watcher & Prompts (2026-08-14)

- **BYOK embedder chain** (`packages/akg-indexer/src/embedder.ts`): `EmbedderStrategy = "local" | "llm" | "none"`, resolved **once** at `init` so index + query vectors share a dimension (local ONNX 384 vs BYOK OpenAI 1536 — never mix). Local-first by default, only attempted when `onnx/model.onnx` exists; `ASTRIVYA_EMBED_BYOK=1` (+ `ASTRIVYA_OPENAI_KEY`) prefers the OpenAI `text-embedding-3-small` API (raw fetch, no SDK, 30s timeout, normalize). Anthropic keys never produce llm (no native embedding API). `akg-query.ts` guards `emb.available()` — strategy `none` means keyword-only search, never an embed attempt. `tryLocal` uses dynamic `await import("@xenova/transformers")` so vitest `vi.mock` can intercept it (mocking `require()` does not work); tsup emits `require` in the CJS bundle so the peer dep stays lazy in production.
- **Cloud vector merge** (`packages/mcp-server/src/handlers.ts`): `cloudSearchNodes` sends the query `embedding` in the POST body; `search_memories` fuses local + cloud node lists via `reciprocalRankFusion` (k=60, dedupe by id/chunkId/nodeId/filePath, exported for tests) and applies the `active_file` boost to the fused list (was: boost written to `results` while returning `merged`).
- **Shared Watcher** (`packages/akg-indexer/src/watcher.ts`, exported from akg-indexer): recursive `fs.watch`, 600ms debounce, ignores hidden dirs + `node_modules/dist/out/coverage/graphify-out/.astrivya` + `.json/.lock/.db/.log/.tmp/.sqlite`, `start()` returns boolean, idempotent `stop()`. Used by `astrivya serve` (atlas) and by the mcp-server HTTP transport when `ASTRIVYA_WATCH=1` (`startWorkspaceWatcher` in `packages/mcp-server/src/index.ts`): change → `indexFile` → `embedAllChunks` → `refreshContextDigest` → journal `auto_index {mode:"watch"}`; stopped on shutdown. `indexFile` only indexes `.md` under `docs/adr` — other files are intentionally ignored.
- **MCP prompts** (`packages/mcp-server/src/prompts.ts`): `session_start`, `remember_after_task`, `decision_required` exposed via `prompts/list` + `prompts/get` (arguments interpolated), advertised in `initialize` capabilities. The `session_start` prompt steers clients to `get_context_digest` + `search_memories` for context.
- **Env vars**: `ASTRIVYA_EMBED_BYOK=1`, `ASTRIVYA_EMBED_MODEL` (default `text-embedding-3-small`), `ASTRIVYA_OPENAI_KEY` (already), `ASTRIVYA_WATCH=1` (HTTP watcher).

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
