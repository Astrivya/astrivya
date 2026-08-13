# Releasing Astrivya

The MCP server's **tool surface is defined in exactly one place**:
`CORE_TOOL_DEFINITIONS` in `packages/mcp-server/src/schemas.ts`. Every surface
that documents it — the mcp-server README, its package.json description, and
both `agent-onboarding/SKILL.md` copies (the `.opencode` agent skill and the
docs site) — is checked against it by:

```bash
npm run check:docs
```

This script **fails (exit 1)** listing the exact surfaces that drifted, and it
runs in CI on every push/PR, so a stale count blocks merges. Follow the steps
below and it can't silently go stale again.

---

## 1. You changed the MCP tool surface

1. Edit `CORE_TOOL_DEFINITIONS` in `packages/mcp-server/src/schemas.ts` first —
   this is the source of truth. Add/remove/rename tools there.
2. Run `npm run check:docs`. It tells you exactly which docs disagree.
3. Fix the listed docs:
   - `packages/mcp-server/README.md` — tools table + "Provides N tools"
   - `packages/mcp-server/package.json` — description string
   - `.opencode/skills/agent-onboarding/SKILL.md` — tools table + counts
   - `astrivya-docs/public/agent-onboarding/SKILL.md` — same, keep it identical
     to the `.opencode` copy (it's the published docs-site version of the skill)
4. Re-run `npm run check:docs` until green.
5. If you added tools, extend the assertions in
   `packages/mcp-server/src/__tests__/exports.test.ts` (it currently asserts
   presence of key tools, not the full count).

## 2. Pre-release gates (all must pass)

```bash
npm run lint
npm run build:all
npm run typecheck
npm run test          # akg-core, akg-indexer, mcp-server, cli
npm run check:docs
```

> Note: on Windows checkouts, `npm run lint` may flag pre-existing CRLF
> line-endings in committed files (biome wants LF). CI checks out with LF and
> passes — don't "fix" those files as part of a release. Only new `lint/` rule
> diagnostics in changed files are your responsibility.

Plus a live smoke from the freshly built CLI:

```bash
node packages/cli/dist/index.js doctor --mcp
# expect: "N tools served" where N == the count printed by check:docs (18 today)
```

Plus, before any release that touches the **cloud plugin flow** (plugin-runtime
sync/download/load, or the cloud-cli/cloud-mcp plugins served by
`api.astrivya.ai`), run the cloud smoke against the deployed surface:

```bash
ASTRIVYA_TOKEN=<real PAT> node scripts/cloud-smoke.mjs            # default api.astrivya.ai
ASTRIVYA_TOKEN=<real PAT> ASTRIVYA_BASE_URL=https://app.astrivya.ai \
  node scripts/cloud-smoke.mjs                                     # working MVP cloud
```

and confirm `plugins sync` installs cloud-cli/cloud-mcp and `astrivya who` /
`astrivya briefing` return live data (the plugins exercise the exact
manifest → download → load path users hit). This is the gate that catches a
stale-global `astrivya-mcp` (RELEASING.md §5) or a broken plugin artifact.

## 3. Version bump + publish

- Versions and changelogs are driven by **release-please** (Conventional
  Commits): workflow `.github/workflows/release.yml`, config
  `.github/release-please-config.json`, manifest `.release-please-manifest.json`.
  Merging the "Release" PR tags the packages and triggers the publish job,
  which re-runs `npm run check:docs` as its **last gate before publishing**
  (aborts the release if the tool surface drifted).
- After release-please opens the "Release" PR, the workflow **automatically
  prepares the branch** ("Prepare release branch" step): it aligns the
  inter-package `@astrivya/*` ranges to the new version via
  `scripts/align-release-ranges.mjs` (release-please bumps `version` fields
  but leaves ranges stale, which would break `npm ci`), regenerates
  `package-lock.json`, and re-applies biome formatting. No manual step — but
  let the PR's CI finish before merging (it re-runs on the prepared head).
- `scripts/publish-bootstrap.sh` is a **one-time bootstrap** for the initial
  baseline — do not re-run it for routine releases.

## 4. Publish order (bases before dependents)

```
akg-core → plugin-api → plugin-runtime → akg-indexer → mcp-server → cli
```

`cli` bundles `mcp-server`, so **mcp-server must be published before cli**.

## 5. Post-publish verification (do not skip)

1. `npm view @astrivya/mcp-server dist-tags` — `latest` equals the released version.
2. On a **clean machine** (no global installs, no monorepo links):
   ```bash
   npx -y @astrivya/mcp-server        # initialize handshake; count the tools
   astrivya doctor --mcp              # expect "N tools served"
   ```
3. **Stale-global hazard:** if any machine has an older
   `@astrivya/mcp-server` installed globally, `npx` silently serves **that**
   version instead of the freshly published one. If the tool count is wrong,
   check `npm ls -g --depth=0` and remove the stale install
   (`npm uninstall -g @astrivya/mcp-server`), then verify again. This exact
   bug served the old 14-tool server during onboarding testing.
4. If the tool surface changed, confirm both SKILL.md copies shipped the
   update, and re-run `npm run check:docs` from a workspace that contains them.

## 6. If drift is found after release

`npm run check:docs` output lists the exact surfaces to fix. Fix them in the
same PR as the next release — CI will block merges until the counts agree.
