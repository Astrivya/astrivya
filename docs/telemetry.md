# Telemetry Event Schema (Contract)

Single source of truth for every event Astrivya sends to PostHog (project
541903). The PostHog dashboards and alerts in `astrivya-deploy/posthog/` query
**these** event names and properties - if an insight comes back empty, the
product changed an event and this doc + the dashboard must be updated together.

Three emitters, three `product` values:

| Product | Emitter | Base `product` value | Opt-out |
|---|---|---|---|
| CLI | `packages/cli/src/lib/telemetry.ts` | `cli` | `astrivya config set telemetry off`, `NO_TELEMETRY`, `ASTRIVYA_TELEMETRY=off`, CI |
| MCP server | `packages/mcp-server/src/telemetry.ts` (called from `status.ts`) | `mcp-server` | same env-var knobs as CLI |
| Cloud app | `Astrivya-MVP/src/lib/analytics/server.ts` + `client.tsx` | n/a (PostHog SDK) | no-op without `NEXT_PUBLIC_POSTHOG_KEY` |

## Base properties (attached to every OSS event)

`install_id` (per-install UUID, the PostHog `distinct_id`), `product`,
`cli_version`/`server_version`, `node_version`, `os_name`, `os_version`, `arch`.

## Forbidden property keys (never emitted, stripped structurally)

`path`, `paths`, `file`, `files`, `dir`, `directory`, `args`, `arg`,
`commandArgs`, `query`, `content`, `token`, `secret`, `key`, `message`,
`stack`, `error`. Failures use `error_type` instead of `error`. The guard is
structural (in `buildCapturePayload`), not convention-based.

## CLI events

### `oss_cli_command` - every CLI command run, once per invocation

| Property | Type | Notes |
|---|---|---|
| `command` | string | e.g. `"akg query"`, `"config set"` |
| `duration_ms` | number | |
| `exit` | `ok` \| `error` | |
| `error_type` | string, optional | `Error.name` on failure only |

### `oss_cli_update` - auto-update install attempt result

| Property | Type | Notes |
|---|---|---|
| `ok` | boolean | install succeeded |
| `from_version` | string | running version |
| `to_version` | string, optional | target version (omitted on forced reinstall) |
| `error_type` | string, optional | failure reason (`Error.name`) |

### `oss_mcp_cascade_update` - standalone global MCP server cascade update

| Property | Type | Notes |
|---|---|---|
| `ok` | boolean | |
| `reason` | string | outcome kind (e.g. `updated`) |

## MCP server events

### `oss_mcp_server_start` / `oss_mcp_server_stop`

| Property | Type | Notes |
|---|---|---|
| `transport` | `stdio` \| `http` | |
| `server_version` | string | start only |
| `reason` | string | stop only: `SIGINT`, `SIGTERM`, `stdin_closed`, ... |
| `uptime_ms` | number | stop only |

### `oss_mcp_session_start` / `oss_mcp_session_end`

| Property | Type | Notes |
|---|---|---|
| `transport` | `stdio` \| `http` | |
| `client_type` | string \| null | **the** client identifier (`"stdio"` for stdio; HTTP User-Agent otherwise). Do NOT rename - dashboards break on property drift (`client` was the wrong key once) |
| `session_id` | string | session-scoped, start+end correlate on it |
| `tool_calls` | number | end only: tools invoked this session |

### `oss_mcp_tool_call` - one per (session, tool) pair, **sampled**

| Property | Type | Notes |
|---|---|---|
| `transport` | `stdio` \| `http` | |
| `tool` | string | tool name |
| `ok` | boolean | |
| `duration_ms` | number, optional | |
| `session_id` | string, optional | |

Sampling: `telemetryToolCall` emits **once per session per tool** (first call),
not per invocation - PostHog tool-call volume understates real volume by
design. Do not "fix" this without updating the dashboards' expectations.

## Cloud events (`Astrivya-MVP`)

| Event | Properties | Emitted at |
|---|---|---|
| `auth_signup_completed` | `method` (Clerk verification strategy) | Clerk webhook, user.created |
| `auth_login` | - | `PostHogIdentity.tsx` (client) |
| `chat_completed` | `model`, `mode` (`web`/...), `input_tokens`, `output_tokens`, `duration_ms` | `/api/chat` |
| `space_created` | - | `/api/spaces` |
| `note_created` | - | `/api/notes` |
| `subscription_created` | `tier`, `subscription_id` | `/api/payments/subscribe` |
| `subscription_activated` | `tier`, `subscription_id` | payments webhook |
| `subscription_cancelled` | `tier`, `subscription_id` | webhook + manage-subscription |
| `subscription_upgraded` | `tier`, `subscription_id` | manage-subscription |
| `subscription_downgrade_scheduled` / `subscription_downgrade_applied` | `tier`, `subscription_id` | manage-subscription / webhook |
| `$pageview` | `pathname` | client router (PostHog autocapture is off) |

## Contract rules

1. **Never rename or repurpose an event or property without updating
   `astrivya-deploy/posthog/` in the same change** - dashboards, formulas and
   alerts match on exact names. The `client` -> `client_type` incident is the
   cautionary tale: an insight silently renders empty.
2. New properties are additive. Prefer adding a property over a new event.
3. Never emit a forbidden key - the guard strips it, silently dropping data
   (including on `error` -> use `error_type`).
4. Cloud events key on the PostHog `distinct_id` (Clerk user id); OSS events
   key on the anonymous `install_id`.
5. Telemetry must never throw, block, or surface - all emitters are
   fire-and-forget with timeouts and swallowed failures.