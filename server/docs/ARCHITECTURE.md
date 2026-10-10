# Server architecture (`server/src`)

Organised by feature: a feature folder owns its handlers, SQL and logic; plumbing is shared.

| Module | Owns |
| --- | --- |
| `main.rs` / `app.rs` | Bootstrap; router assembly and the middleware stack. `app::api_routes()` merges every feature's `routes()` under `/api`. |
| `config.rs`, `error.rs`, `state/` | Env config parsed once; `ApiError`/`ApiResult`; the shared `AppState` (registry, media, RPC waiters, throttles). |
| `http/` | `AuthUser`, `RequireAdmin`, `RequireOperator`, client-IP/audit helpers, pagination, HTTPS/cache/metrics/CORS middleware, trusted proxies. |
| `db/` | Pool + embedded migrations and tiny shared helpers (`unix_to_dt`, `pg_is_unique_violation`). No feature queries. |
| `auth/` | `require_auth`, login/logout, lockout, session cookie + CSRF, OIDC, 2FA, secrets, dashboard users. |
| `agents/` | Directory, lifecycle, enrollment, module grants, capabilities, telemetry, logs, analytics, groups, Wake-on-LAN, auto-update, fleet summary. |
| `agent_ws/` | `/ws/agent`: connection, event dispatch (by `vantyr_protocol::AgentMessage`), Recall keyframe ingest, policy pushes to agents (typed `ServerCommand`s). |
| `viewer/`, `control/` | Dashboard sockets; input leases, capture arbitration, clipboard, live screen/audio. |
| `recall/` | Screen history: API (cursor, handlers, settings, blob), index db, blob store, context, narrative, retention. |
| `policy/` | App blocking, internet blocking, alert rules (`engine` evaluates matches). |
| `web_activity/` | URL visits/sessions (`ingest` categorizes before insert) and URL categorization. |
| `scripts/` | Remote and scheduled scripts, the minute scheduler, software inventory. |
| `platform/` | Audit log, retention, storage, version, assets, local-UI password, web push, metrics, mDNS. |
| `notify/`, `integration.rs` | Outbound alert channels (+ admin test endpoint); the bearer-token integration API. |

## Layout of a feature

- `mod.rs` documents the feature and exposes `pub fn routes() -> Router<Arc<AppState>>`
  (public, unauthenticated routes use `public_routes()` and are mounted explicitly in `app.rs`).
- `api.rs` (or a few handler files) holds axum handlers only: extract, validate, call the
  feature's functions, audit, shape the response.
- `service.rs` (optional; otherwise the feature's `mod.rs`) holds logic that is neither HTTP nor SQL:
  hashing, token minting, bootstrap, verification. It calls `db` functions with values already
  computed. When a flow must stay atomic (lock, decide, write), the service opens the
  transaction and passes `&mut PgConnection` to `db` functions (see `agents/enrollment/service.rs`);
  `auth/users/service.rs` hashes passwords before `db::users` stores them.
- `db.rs` (or a `db/` folder for large features) holds every SQL statement for the feature,
  returning typed row structs. Static SQL uses the compile-time checked `sqlx::query!` macros;
  see [database.md](database.md). Callers import it by path (`use crate::recall::db as recall_db;`);
  there are no glob re-exports.
- Tests live beside the code as `#[cfg(test)] mod tests` or a `tests.rs` child module. Fixtures
  shared across features live in `test_support/`. Database tests use `#[sqlx::test]` and need
  `DATABASE_URL`; see [testing.md](testing.md).

## Dependency rules

1. Dependencies point down: handlers -> feature services -> feature `db`. `db` modules never call
   feature logic (shared row types and pure helpers are fine) and only run SQL: no hashing,
   token generation or other domain decisions inside a `db` function.
2. Background jobs (`scripts::scheduler`, URL categorization worker, narrative, retention) and the
   agent socket call feature functions, never HTTP handler modules.
3. A feature may call another feature's service or `db` functions; it should not reach into its
   handlers. Shared request plumbing belongs in `http/`, not in a feature.
4. `state/` never calls feature code; feature behaviour on `AppState` lives in its feature (`impl AppState`).

## Wire protocol

Commands to agents, messages from agents, the module catalogue and the Recall context vocabulary
come from the shared [`vantyr-protocol`](../../protocol/README.md) crate (a workspace member that
the agent also depends on). The server builds commands as `ServerCommand` variants and sends them
with `AgentRegistry::send_command`; `agents::modules::command_module` / `protocol_command` read
`ServerCommand::gate`, so the server and the agent cannot disagree on which commands are gated.
Dashboard-originated remote-input, file-browser and notify commands are validated in
`viewer/ws.rs` and forwarded as raw JSON; the agent parses those strictly itself.

## Generated dashboard types

The response and request structs the dashboard reads derive [`ts_rs::TS`](https://docs.rs/ts-rs)
(`#[derive(TS)] #[ts(export)]`) and are written to `frontend/src/api/types/generated/`, one `.ts`
file per type, which `frontend/src/api/types/<domain>.ts` re-export. The generated files are
committed so the frontend builds without Rust. Rules for a type that is generated:

- Derive `TS` on the struct a handler actually serializes, next to its `Serialize`, and keep
  serde attributes honest: `rename`, `rename_all`, `tag` and `flatten` are followed by ts-rs.
  `skip_serializing_if = "Option::is_none"` needs `#[ts(optional)]` as well (a serialize-only
  struct has no `#[serde(default)]`, which ts-rs would otherwise require).
- `i64`/`u64` become `number` (`TS_RS_LARGE_INT` in the root `.cargo/config.toml`), `DateTime`
  and `Uuid` become `string`, `serde_json::Value` becomes `JsonValue`. Use `#[ts(type = "...")]`
  for a field whose wire shape is built by hand.
- Endpoints that still build their body with `json!` have no generated type; their TypeScript stays
  hand-written until the handler returns a struct.

Regenerate after changing one of these types (it needs no database, only `SQLX_OFFLINE=true` to
compile the server):

```sh
SQLX_OFFLINE=true cargo test --workspace export_bindings
```

then commit the diff under `frontend/src/api/types/generated` with the Rust change.
`TS_RS_EXPORT_DIR` and `TS_RS_LARGE_INT` are set for the whole workspace in `.cargo/config.toml`.
`vantyr-protocol` only pulls ts-rs in through its `ts` feature, which the server enables, so the
agent build is unaffected; run the command at the workspace root (not `-p vantyr-protocol` alone,
which would not enable the feature). To check that the committed files are current:
`cargo test --workspace export_bindings && git diff --exit-code frontend/src/api/types/generated`.
