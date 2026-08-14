# Changelog

## [0.5.0](https://github.com/Astrivya/astrivya/compare/cli-v0.4.0...cli-v0.5.0) (2026-08-14)

### Features

* **cli:** auth login method menu + OAuth pre-flight probe ([ef2a1fa](https://github.com/Astrivya/astrivya/commit/ef2a1fa6c7c7b9a68864b1206c370a841b9173d3))
* **cli,mcp-server:** telemetry health events + stdio shutdown flush ([034222f](https://github.com/Astrivya/astrivya/commit/034222f505e6e012c5582df4d0d5aafc65f04ff5))

## [0.4.0](https://github.com/Astrivya/astrivya/compare/cli-v0.3.0...cli-v0.4.0) (2026-08-14)


### Features

* **akg,cli:** repo/person identity graph, file-target search, storage v3 ([ace76c2](https://github.com/Astrivya/astrivya/commit/ace76c2c7c0be4d6bf0f4a0670a39a366d9bdcd0))
* **cli,mcp-server:** anonymous opt-out usage telemetry via PostHog ([a603a09](https://github.com/Astrivya/astrivya/commit/a603a0912d092f901977b0e4717387654ad9395a))
* **cli,mcp-server:** anonymous opt-out usage telemetry via PostHog ([cdddc95](https://github.com/Astrivya/astrivya/commit/cdddc952c2b3c25b9259d2ddea7916d772da3411))
* **cli,mcp-server:** user-end auto-update — prompt install, silent mode, plugin auto-sync ([5e0a295](https://github.com/Astrivya/astrivya/commit/5e0a29511131491d85d72c22fa0c83bec1f2fc8e))
* **cli:** cascade update — standalone mcp-server + forced plugin sync after CLI update ([a63b189](https://github.com/Astrivya/astrivya/commit/a63b189bf5cd8470c6b9fe3f5c812e2e390e2034))
* **mcp,cli,atlas:** per-session registry, HTTP lifecycle, journal rendering fix ([061fdf6](https://github.com/Astrivya/astrivya/commit/061fdf6f0a0fa9d04e414d97d765ca2525f34ce9))


### Bug Fixes

* **cli,mcp:** align cloud endpoints with api.astrivya.ai + contract drift gate ([805dbaf](https://github.com/Astrivya/astrivya/commit/805dbaf1cd19fb83ca479b2408245e59efb626e0))
* **cli,mcp:** align cloud endpoints with api.astrivya.ai + contract drift gate ([234a160](https://github.com/Astrivya/astrivya/commit/234a160d7c769c048b1cb53935e3a63d8bc29011))
* **cli:** auth-gate cloud commands, inject plugin env, HTML-safe API errors, exitCode hygiene ([26a6da9](https://github.com/Astrivya/astrivya/commit/26a6da9380f4c5677b9513f8d9449c09841b5711))
* **cli:** load cloud plugin commands on Windows + cloud smoke test ([#21](https://github.com/Astrivya/astrivya/issues/21)) ([e1e7efb](https://github.com/Astrivya/astrivya/commit/e1e7efb7a16306fc9d5a7704068799367a0df153))
* **cli:** sort imports in cloud-contract test for biome 1.9.4 ([67d56fa](https://github.com/Astrivya/astrivya/commit/67d56fa63041797b0532d6fc72b6a9bbe6b4985b))
* **cli:** update-flow diagnostics, forced session check, entry-guard exit hygiene ([090b889](https://github.com/Astrivya/astrivya/commit/090b8899fd4e478dc7f9402b8e41d83f298dbda8))

## [0.3.0](https://github.com/Astrivya/astrivya/compare/cli-v0.2.1...cli-v0.3.0) (2026-08-13)


### Features

* **cli:** production hardening — bug fixes, e2e suite, and doc-drift gate ([a6141e9](https://github.com/Astrivya/astrivya/commit/a6141e9a6184caae42c24439bce909911e24ef13))


### Bug Fixes

* unknown command must error, not launch the TUI; upgrade gitleaks action ([8a24fa4](https://github.com/Astrivya/astrivya/commit/8a24fa40445c42d56055f702a0f514ddc56375a4))

## [0.2.1](https://github.com/Astrivya/astrivya/compare/cli-v0.2.0...cli-v0.2.1) (2026-08-12)


### Bug Fixes

* align [@astrivya](https://github.com/astrivya) inter-package ranges to 0.2.0 workspace versions ([491e16c](https://github.com/Astrivya/astrivya/commit/491e16c76e929626881b177dc3386d9fd7ecf00e))

## [0.2.0](https://github.com/Astrivya/astrivya/compare/cli-v0.1.0...cli-v0.2.0) (2026-08-12)


### Features

* **cli:** push chunk embeddings to team cloud graph ([2333b3d](https://github.com/Astrivya/astrivya/commit/2333b3da978dd61e89d957cb82faa871e94dfb6b))
* **cli:** show live credit balance in 'astrivya status' (balance, used, purchased, refill date) ([d82d3eb](https://github.com/Astrivya/astrivya/commit/d82d3ebc418bc7955b15c00a8182af7f3e9fe1a6))
* **graph:** activate graph features + fix MCP sync contract ([a429e09](https://github.com/Astrivya/astrivya/commit/a429e093c1c1bbf558ba963c9667ae35d6e27d1e))
* initial release of Astrivya OSS — knowledge graph engine, indexer, MCP server, CLI ([c74f8ab](https://github.com/Astrivya/astrivya/commit/c74f8ab1b08152deb3ab20e575fe786ebee68f3f))


### Bug Fixes

* **cli,mcp-server:** gate update-notifier CI opt-out at entry point ([798e93c](https://github.com/Astrivya/astrivya/commit/798e93c4c0863d02259510284b9601a02fbaeab2))
