# Changelog

## [0.6.0](https://github.com/Astrivya/astrivya/compare/mcp-server-v0.5.0...mcp-server-v0.6.0) (2026-08-16)


### Features

* **mesh:** Agent Mesh v1 - A2A identity + typed messaging + Atlas panel ([6f55bd2](https://github.com/Astrivya/astrivya/commit/6f55bd224ecb2220abd5ef678b9ffa77f9013e45))
* **mesh:** agent-to-agent mesh with identity, typed messages, Atlas panel ([5857cdb](https://github.com/Astrivya/astrivya/commit/5857cdba4c653e0622e6cb28988cc555d755b62b))
* **mesh:** follow-up batch — send route, compose, unread badge, repo-aware graph hierarchy ([#49](https://github.com/Astrivya/astrivya/issues/49)) ([fc6c8d3](https://github.com/Astrivya/astrivya/commit/fc6c8d30d578c054cfdfd9f92e37d75a773a7222))

## [0.5.0](https://github.com/Astrivya/astrivya/compare/mcp-server-v0.4.0...mcp-server-v0.5.0) (2026-08-14)

### Features

* **akg,mcp:** BYOK embedder chain, cloud RRF fusion, shared watcher + prompts ([524798f](https://github.com/Astrivya/astrivya/commit/524798fb84bd6ea0d273fdda642165e86afc57cc))
* **cli,mcp-server:** telemetry health events + stdio shutdown flush ([034222f](https://github.com/Astrivya/astrivya/commit/034222f505e6e012c5582df4d0d5aafc65f04ff5))

## [0.4.0](https://github.com/Astrivya/astrivya/compare/mcp-server-v0.3.0...mcp-server-v0.4.0) (2026-08-14)


### Features

* **cli,mcp-server:** anonymous opt-out usage telemetry via PostHog ([a603a09](https://github.com/Astrivya/astrivya/commit/a603a0912d092f901977b0e4717387654ad9395a))
* **cli,mcp-server:** anonymous opt-out usage telemetry via PostHog ([cdddc95](https://github.com/Astrivya/astrivya/commit/cdddc952c2b3c25b9259d2ddea7916d772da3411))
* **cli,mcp-server:** user-end auto-update — prompt install, silent mode, plugin auto-sync ([5e0a295](https://github.com/Astrivya/astrivya/commit/5e0a29511131491d85d72c22fa0c83bec1f2fc8e))
* **mcp,cli,atlas:** per-session registry, HTTP lifecycle, journal rendering fix ([061fdf6](https://github.com/Astrivya/astrivya/commit/061fdf6f0a0fa9d04e414d97d765ca2525f34ce9))


### Bug Fixes

* **cli,mcp:** align cloud endpoints with api.astrivya.ai + contract drift gate ([805dbaf](https://github.com/Astrivya/astrivya/commit/805dbaf1cd19fb83ca479b2408245e59efb626e0))
* **cli,mcp:** align cloud endpoints with api.astrivya.ai + contract drift gate ([234a160](https://github.com/Astrivya/astrivya/commit/234a160d7c769c048b1cb53935e3a63d8bc29011))

## [0.3.0](https://github.com/Astrivya/astrivya/compare/mcp-server-v0.2.1...mcp-server-v0.3.0) (2026-08-13)


### Features

* **cli:** production hardening — bug fixes, e2e suite, and doc-drift gate ([a6141e9](https://github.com/Astrivya/astrivya/commit/a6141e9a6184caae42c24439bce909911e24ef13))

## [0.2.1](https://github.com/Astrivya/astrivya/compare/mcp-server-v0.2.0...mcp-server-v0.2.1) (2026-08-12)


### Bug Fixes

* align [@astrivya](https://github.com/astrivya) inter-package ranges to 0.2.0 workspace versions ([491e16c](https://github.com/Astrivya/astrivya/commit/491e16c76e929626881b177dc3386d9fd7ecf00e))

## [0.2.0](https://github.com/Astrivya/astrivya/compare/mcp-server-v0.1.0...mcp-server-v0.2.0) (2026-08-12)


### Features

* **graph:** activate graph features + fix MCP sync contract ([a429e09](https://github.com/Astrivya/astrivya/commit/a429e093c1c1bbf558ba963c9667ae35d6e27d1e))
* initial release of Astrivya OSS — knowledge graph engine, indexer, MCP server, CLI ([c74f8ab](https://github.com/Astrivya/astrivya/commit/c74f8ab1b08152deb3ab20e575fe786ebee68f3f))
* **mcp-server:** cloud vector search + team digest payload ([3e05655](https://github.com/Astrivya/astrivya/commit/3e0565523892e0ba4c50cbfe0861aa919576e63d))
* **mcp:** add check_credits tool (live balance, lifetime usage, recent transactions) ([e3becd9](https://github.com/Astrivya/astrivya/commit/e3becd962476a9f45b1c2a27795f092f12d54f44))


### Bug Fixes

* **cli,mcp-server:** gate update-notifier CI opt-out at entry point ([798e93c](https://github.com/Astrivya/astrivya/commit/798e93c4c0863d02259510284b9601a02fbaeab2))
