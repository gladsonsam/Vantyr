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
| `agent_ws/` | `/ws/agent`: connection, event dispatch, Recall keyframe ingest, policy pushes to agents. |
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
- `db.rs` holds every SQL statement for the feature, preferably returning typed row structs.
  Callers import it by path (`use crate::recall::db as recall_db;`); there are no glob re-exports.
- Tests live beside the code as `#[cfg(test)] mod tests` or a `tests.rs` child module.

## Dependency rules

1. Dependencies point down: handlers -> feature services -> feature `db`. `db` modules never call
   feature logic (shared row types and pure helpers are fine).
2. Background jobs (`scripts::scheduler`, URL categorization worker, narrative, retention) and the
   agent socket call feature functions, never HTTP handler modules.
3. A feature may call another feature's service or `db` functions; it should not reach into its
   handlers. Shared request plumbing belongs in `http/`, not in a feature.
4. `state/` never calls feature code; feature behaviour on `AppState` lives in its feature (`impl AppState`).
