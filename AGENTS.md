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

## Private Packages & Registry

Proprietary `@astrivya/*` packages (cloud, cloud-cli, cloud-mcp, cloud-api,
cron-worker, infra-shared, mcp-gateway — license `FSL-1.1-ALv2`) are **NOT**
published to public npm. They live in the private sibling repo
`../astrivya-infra/` and publish to the private registry only (auth required,
never proxied to public npm). Full private-registry operations (publish CI,
credentials, VM checkout, auth gotchas) are documented in that repo's
`AGENTS.md` and the private workspace's `ops-findings.md` — deliberately NOT
in this public repo.

- **Leak guard:** NEVER add a workflow in this repo (or re-create the deleted infra one) that publishes `@astrivya/cloud*`/`infra-shared`/`mcp-gateway` to public npmjs — an old infra workflow did (Aug 2026) and leaked three 0.1.0 packages before being deleted and unpublished.
- `cron-worker` is a Cloudflare Workers source package (no `dist`/`main`; wrangler compiles from `src` at deploy time). Do **not** add a `files`/`main` to it.

## Cross-Repo Dev

- OSS packages call cloud via HTTP, not package imports.
- Env var `ASTRIVYA_CLOUD_URL=http://localhost:3000` wires them together.
- `scripts/dev.sh` starts both servers from the sibling repo, sets env vars.

## Cloud Packages & Plugin Artifacts (2026-08-14)

**Why no cloud packages on public npm:** the 7 proprietary packages (`cloud`,
`cloud-api`, `cloud-cli`, `cloud-mcp`, `cron-worker`, `infra-shared`,
`mcp-gateway` — license `FSL-1.1-ALv2`) live only in the private
`../astrivya-infra/` repo and publish only to the private registry. A
private-scope registry mapping exists **only in the infra repo's `.npmrc`**;
the OSS repo maps no scope, so its packages land on npmjs.org. Verified
2026-08-14: zero `@astrivya/cloud*`/`infra-shared`/`mcp-gateway` imports in
any OSS `package.json` or `.ts` file, and no private-registry references in
the published `cli@0.4.0` dist.

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
- Publishing uses `NPM_TOKEN` (repo is public; no OIDC/provenance).
- **Self-driving ceremony (2026-08-14):** release.yml now triggers on `push` to main, so every merge runs release-please automatically (manual dispatch still works). The "Prepare release branch" step pushes with `RELEASE_PLEASE_TOKEN` (a human PAT) — GITHUB_TOKEN pushes are suppressed by GitHub, so their CI never reports and branch protection blocks the release PR. The "Enable auto-merge" step then hands the release PR to `gh pr merge --auto`; when its checks pass it merges, and the merge push re-triggers the workflow → releases + tags → publish job. If auto-merge stalls (e.g. release-please force-pushed mid-cycle), the next run re-enables it. Gap-fill single-package publishes: `publish-tagged.yml`.
- **Known release-please blind spot (2026-08-14):** commits merged to main via a MERGE commit (not squash) are invisible to release-please when their PR merge message isn't Conventional — e.g. `524798f feat(akg,mcp): BYOK embedder chain…` (via PR #27) was never picked up, so the 0.5.0 release needed a manual release PR. If release-please reports "No user facing commits found", check `git log <last-tag>..main -- packages/<pkg>` for merge-commit-swept features and prefer squash merges going forward.

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

## Agent Mesh & A2A (2026-08-15)

- **What it is**: an agent-to-agent channel between coding sessions sharing a workspace. Sessions announce identity (`identify_agent`), talk via `agent_message` (typed, threaded), and read the feed via `mesh_read`. Messages land in the shared workspace journal (`<workspace>/.astrivya/mcp/events.ndjson`, same file the sessions registry uses) and are indexed into the AKG as `agent_message` nodes + `mesh://messages` chunks (semantically searchable via `search_memories`; embedding is fire-and-forget via `embedAllChunks`, best-effort).
- **Identity (4 layers, merged by `mergeAgentIdentity` in `status.ts`)**: (1) MCP `initialize` clientInfo — captured by overriding `InitializeRequestSchema` in `index.ts:createServer()` (replicates the SDK default response: `SUPPORTED_PROTOCOL_VERSIONS` negotiation + `{ tools, resources, prompts }` capabilities + serverInfo); stashed as pending client info and attached when the session row is created. (2) spawn facts (pid/workspace, journal-derived). (3) env: `ASTRIVYA_AGENT_NAME`/`_MODEL`/`_PROVIDER`/`_SESSION`/`_CWD`/`_PROJECT` (`envAgentIdentity()`). (4) self-registration via `identify_agent` (explicit values win; kept in `_agentIdentityById` even without a session row). `setAgentIdentity` journals an `agent_identify` event (roster rebuilt from the journal by Atlas, no live server needed).
- **Message taxonomy**: `general · code-conflict · release · tag · ci · deploy · vm · git-push · review · blocker · question` (`MESH_MESSAGE_TYPES`), urgency `info|low|normal|high`, `to: "all"|agent-id`, `thread_id`/`in_reply_to`, `context { files[] (≤20), repos[], branch, lineRange, topic }`, 8000-char text cap. Journal rows use `msg_type` for the taxonomy key — the plain `type` field is the event type (`agent_message`) and would collide (appendEvent spreads data over the event type).
- **Tools**: `identify_agent`, `agent_message`, `mesh_read {limit(≤500), since, agent, type}` — all local/cheap, wrapped in the canonical envelope. `handleToolCall(name, args, ctx?)` now threads `{ sessionId, clientVersion }` from the transport (index.ts CallTool handler); handlers read the session id via `meshSessionId(ctx)` (falls back to `stdio:<pid>`).
- **Atlas Agent Mesh panel**: `astrivya serve` serves `/api/mcp/mesh` — journal-direct (reads `readJournal(workspace, 5000)`, filters `agent_message` + `agent_identify`, decorates senders with `isPidAlive` from `commands/mcp.ts`; no live MCP server required). The panel (App.tsx `SessionsPanel`, renamed "Agent Mesh") polls both `/api/mcp/status` + `/api/mcp/mesh` every 3s while open; when agents are alive it docks side-by-side (`atlas-app.mesh-docked` shrinks the canvas to 360px), otherwise it's a drawer with a CTA. The roster is **sessions-based**: `/api/mcp/mesh` returns `sessions` derived via `journalSessionRows` (every session the journal ever saw, classified active/orphan/ended by PID liveness, identity-merged from `agent_identify`, plus client/mode/startedAt from `session_start`) — so ALL currently running sessions show even with no live HTTP server; a "Show previous sessions" toggle reveals ended/orphan rows (dimmed, with badges). Senders-only fallback roster renders when no session rows exist. Shows threads (grouped by threadId, type badges — conflict/blocker red, ops amber, review purple, question blue), urgency and file chips. Summary chips show "N running / M total sessions · K mesh messages". New `agent`/`agent_message` node types render in the graph under the "Agent Mesh" layer (#9d7bff).
- **Mesh panel follow-ups (2026-08-15, shipped in feat/mesh-followups)**: `deriveMeshSessions(events, identityById, isAlive)` + `MeshSessionRow` extracted from `packages/cli/src/commands/atlas.ts` (probe injectable for tests — see `__tests__/atlas-mesh.test.ts`); POST `/api/mcp/mesh/send` appends an `agent_message` row (from `atlas`, `pid` = Atlas process) + AKG upserts (`agent:atlas` node, `mesh://messages` chunk, `generated` edge) so host-posted messages are searchable; `attachClientIdentity` in mcp-server `status.ts` fills the identity **name gap only** (never overrides env) and journals `agent_identify` so journal-direct readers pick it up. UI: unread badge on the Users toggle (capped `9+`, cleared on open), compose box with send states (idle/sending/sent) + inline errors + Enter-to-send + autofocus when replying, conflict chips (`code-conflict` + ≥2 msgs sharing a branch or overlapping files), `focusThread` scrolls the focused thread into view, Esc closes the panel (before: Esc only cleared selection), previous sessions grouped (Orphaned/Ended caps + "Show more", probe clients like curl/PowerShell hidden), one-line dual-cluster summary, single `.sessions-body` scroll container with compose pinned, docked panel sits below the header (`top: 48px`). **JSX gotcha (was the "vibecoded" bug)**: JSX text nodes do NOT process `\u` escapes — `\u00b7`/`\u2192`/`\u26a0` render as literal text; use real chars or `{"\u00b7"}` expressions.
- **Auto-start MCP registry (2026-08-15)**: when `astrivya serve` starts and the MCP HTTP registry (`ASTRIVYA_MCP_URL`, default localhost:3001) is unreachable, it spawns `mcp-server --sse --port <port>` as a child (local hosts only; killed on Atlas exit; opt out with `--no-auto-mcp` or `ASTRIVYA_ATLAS_NO_AUTO_MCP=1`). The correct CLI flag is `--sse` (NOT `--http` — the `mcp-server` CLI command has no `--http` option; `--http` is only accepted by the mcp-server *package's own* bin). **Route gotcha**: the POST handler matches BOTH `/api/mcp/mesh` and `/api/mcp/mesh/send` — the SPA static fallback swallows unknown POST paths (returns `index.html`), so a stale route check looks like "POST returns HTML".
- **Coordination protocol**: appended to the `session_start` prompt — check `mesh_read` before editing, announce with `agent_message`, reply in-thread, one driver per release/tag/push, `code-conflict` on overlaps. Soft v1: no enforcement.
- **Env vars**: `ASTRIVYA_AGENT_NAME`, `ASTRIVYA_AGENT_MODEL`, `ASTRIVYA_AGENT_PROVIDER`, `ASTRIVYA_AGENT_SESSION` (optional, per-spawn identity config).

## Key Env Vars

| Var | Used By | Description |
|-----|---------|-------------|
| `ASTRIVYA_CLOUD_URL` | `mcp-server` api.ts | Cloud server endpoint |
| `ASTRIVYA_TOKEN` | `mcp-server`, `cli` | Auth token for cloud features |
| `ASTRIVYA_BASE_URL` | `mcp-server`, `cli` | Fallback API URL (default: https://astrivya.ai) |

## Atlas Graph Hierarchy (2026-08-15)

- **Problem it solved**: the graph showed 1,822 nodes but no hierarchy — `repo::astrivya` had ZERO out-edges (the indexer never wrote `repo→folder` contains edges), and the `repo` type was in no layer, so the graph read as a flat cluster soup. Root cause: the indexer only links a folder to its immediate parent; repos are detected later from git, so their children were never wired.
- **Fix (read-time synthesis in `packages/cli/src/commands/atlas.ts`, `/api/akg/graph`)**: the endpoint now (1) wires `workspace::root → repo` (via existing `workspace contains` edge) and synthesizes `repo → folder` contains edges for every folder whose path is exactly one segment deeper than the repo's `relPath` (`isDirectChild`: relPath `.` ⇒ single-segment folders; nested repos ⇒ `folder::<rel>/<seg>`); (2) attaches a `group` per node — `"workspace"` / `"repo"` / the top-level path segment (`packages`, `docs`, `.opencode`, `README.md`, …); (3) returns `{ nodes, edges, workspace, repos }` where `workspace` is the `workspace::root` node and `repos` is `[{ id, label, relPath, nodeCount }]`. The DB stays append-only — no synthetic edges persisted.
- **Client**: `AkgNode.group`, `AkgRepoInfo`, and `GraphData.workspace/repos` in `packages/atlas/src/api/akg-client.ts`. Layout adds a gentle `forceGroupCentroid()` (0.025) in the refine phase (`force-layout.ts`) so same-group nodes drift together without wrecking community clusters. Theme has a `repo` node color (base #9d7bff). UI: layers panel first group renamed "Repos & Structure" (types `workspace`,`repo`,`folder`, color #9d7bff); status bar shows the workspace root label + top repos with counts; a "Repositories (N)" section in the layers drawer lists each repo + nodeCount.
- **Type counts today** (this repo): document 753, function 502, file 312, interface 101, folder 94, class 43, adr 7, person 3, agent 2, agent_message 2, agent_action 1, repo 1, workspace 1 = 1,822 nodes / ~2,467 edges / 585 chunks / 6.6 MB. The "less nodes than expected" gap is coverage, not a bug — the indexer only indexes `.md` + `.ts/.tsx` under the workspace (144 TS/TSX + 95 MD on disk).

## Conventions

- All DB queries use explicit columns: `.select("id, name, created_at")` never `.select("*")`
- AI SDK: Uses `openai` package directly, NOT `ai` or `@ai-sdk/*`
- Public API surfaces must have JSDoc
- TypeScript strict mode required
