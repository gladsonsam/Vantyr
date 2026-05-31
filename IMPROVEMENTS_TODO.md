# Sentinel — Improvement Backlog (auto-run todo)

This is an ordered, self-contained worklist derived from a critical code review of the
server (Rust/Axum), agent (Rust/Tauri), and dashboard (React 19). It is designed to be
worked through top-to-bottom in auto mode.

## How to run this in auto mode

- Do tasks **in order**. Each is scoped to be a single, reviewable commit on its own branch.
- After each task, run the listed **Verify** commands. If they fail, fix before moving on.
- Tasks marked **[SECURITY]** or **[BEHAVIOR]** change security/observable behavior —
  follow `AGENTS.md` guardrails: inspect surrounding auth/audit/retention paths first,
  keep WebSocket message shapes backward-compatible, and never weaken auth/CSRF/HTTPS
  without it being the explicit point of the task.
- Re-verify exact line numbers before editing — the working tree has uncommitted changes
  and lines may have shifted. The file/symbol references are the source of truth, not the
  line numbers.
- Mark each checkbox `[x]` when its Verify step passes. Update this file in the same commit.

Standard verify commands (per `AGENTS.md`):
- Server: `cargo fmt --all`, `cargo check -p sentinel-server`, `cargo test -p sentinel-server`
- Agent: from `agent/`: `cargo fmt`, `cargo check`
- Frontend: from `frontend/`: `npm run lint`, `npm run build`
- Agent UI: from `agent/ui-src/`: `npm run lint`, `npm run build`

---

## Phase 0 — CI & test scaffolding (do this FIRST; it guards everything after)

- [x] **0.1 Add a PR CI workflow.** Create `.github/workflows/ci.yml` that runs on
  `pull_request` and `push` to `main`:
  - server job: `cargo fmt --all --check`, `cargo clippy -p sentinel-server -- -D warnings`,
    `cargo check -p sentinel-server`, `cargo test -p sentinel-server`.
  - agent job (windows runner): from `agent/`, `cargo fmt --check`, `cargo check`.
  - frontend job: from `frontend/`, `npm ci`, `npm run lint`, `npm run build`.
  - agent-ui job: from `agent/ui-src/`, `npm ci`, `npm run lint`, `npm run build`.
  - Don't break the existing `release-*.yml` workflows.
  - **Verify:** `act` not required; just ensure YAML is valid and job/command names match the
    real scripts in each `package.json` / `Cargo.toml`.

- [x] **0.2 Add Vitest to the frontend.** Add `vitest` + `@testing-library/react` (+ jsdom)
  to `frontend/package.json` devDeps, a `test` script (`vitest run`) and a `vitest.config.ts`.
  Wire the frontend CI job to run `npm test`.
  - **Verify:** `cd frontend && npm install && npm test` runs (zero tests is OK at this point).

---

## Phase 1 — Critical security (small, high-value; one commit each)

- [x] **1.1 [SECURITY] Don't trust client-supplied `X-Forwarded-For` for rate-limiting/lockout.**
  `server/src/auth.rs` — `client_ip_for_audit` (~`auth.rs:896`) blindly trusts the first
  `X-Forwarded-For` hop; `login_client_key`/`SmartIpKeyExtractor` (`auth.rs:175`,
  `main.rs:251`) build brute-force protection on it. Add a configurable trusted-proxy
  allowlist (env var, e.g. `TRUSTED_PROXY_CIDRS`, default empty). Only honor
  `X-Forwarded-For`/`X-Real-IP`/`X-Forwarded-Proto` when the direct TCP peer is in that
  list; otherwise use the `ConnectInfo` peer IP. Keep `client_ip_for_audit` for audit but
  add a separate `trusted_client_ip(...)` used for security decisions.
  - **Verify:** `cargo check -p sentinel-server` + unit test (see 4.1) for both trusted and
    untrusted peer cases.

- [x] **1.2 [SECURITY] Add a per-username login failure counter.** In addition to per-IP
  (`auth.rs:45` `MAX_LOGIN_FAILURES_PER_WINDOW`), track failures per account so header
  rotation can't sidestep the lockout. Reset on success.
  - **Verify:** unit test of the lockout helper; `cargo test -p sentinel-server`.

- [x] **1.3 [SECURITY] Disconnect the live agent on credential revoke.**
  `server/src/api/agents_list.rs` — `revoke_agent_credentials` (`agents_list.rs:38`) updates
  the DB but never drops the WS. After the DB update, call `s.try_disconnect_agent(agent_id)`
  (mirror the wait/cleanup loop already in `delete_agents_bulk`, `agents_list.rs:84-95`).
  - **Verify:** `cargo check -p sentinel-server`.

- [x] **1.4 [SECURITY] Invalidate sessions on password change and user delete.**
  `server/src/api/users.rs` — `user_set_password` (~`users.rs:377`) and the user-delete path
  must `DELETE FROM dashboard_sessions WHERE user_id = $1`. Add a `db::` helper for it.
  Consider also doing this on role change (`user_set_role`, ~`users.rs:423`).
  - **Verify:** `cargo check -p sentinel-server`.

- [x] **1.5 [SECURITY] Gate OIDC auto-provisioning behind a group allowlist.**
  `server/src/auth.rs` — the OIDC callback (`auth.rs:785`) creates a local user for any valid
  IdP login. Add an env var (e.g. `OIDC_ALLOWED_GROUPS`); if set, require the token's groups
  to intersect it before provisioning, else reject with 403. If unset, preserve current
  behavior but log a warning at startup that OIDC is open-provisioning.
  - **Verify:** `cargo check -p sentinel-server`; unit test `map_role_from_groups` + the gate.

- [x] **1.6 [SECURITY] Tighten the agent's SYSTEM named-pipe DACLs.**
  `agent/src/service.rs` — both pipes (`service.rs:127`, `service.rs:172`) grant
  Authenticated Users (`AU`) generic read/write. Restrict to SYSTEM + the active console-user
  SID (the SID is already computed in `active_console_user_sid_string`, `service.rs:209`).
  For the `SentinelAgentService` pipe, also verify the caller via
  `GetNamedPipeClientProcessId` and check the image path is the SYSTEM-launched agent before
  honoring `set_network_policy` / `clear_log_file` (`service.rs:520`).
  - **Verify:** from `agent/`: `cargo check` (Windows). Note in commit msg that this needs
    manual on-box validation that the user-session agent can still connect.

---

## Phase 2 — Critical reliability bugs

- [x] **2.1 Stop the agent from aborting on a hook/UI panic.**
  `agent/Cargo.toml:134` sets `panic = "abort"`, and `agent/src/keyboard_capture.rs:199`
  (`SetWindowsHookExW(...).unwrap_or_else(|e| panic!(...))`) and `agent/src/ui.rs:890`
  (`panic!("main window missing")`) panic on background threads, killing the process.
  Convert these to return `Result`/`Err` propagated to `start()`; on hook-install failure,
  degrade (no keyboard capture) and log, don't abort. Ensure the error reaches the existing
  `ready_tx` reporting path (`main.rs:276`).
  - **Verify:** from `agent/`: `cargo check`.

- [x] **2.2 Fix lost live-status updates in the dashboard WebSocket handlers.**
  `frontend/src/App.tsx` handlers (`App.tsx:600-698`) and `updateAgentLiveStatus` read
  `liveStatus[id]` from the render snapshot, so bursty events drop data. Change
  `updateAgentLiveStatus` to take a `Partial<AgentLiveStatus>` and merge inside a functional
  `setLiveStatus(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))`. Apply the same to
  the `agent_connected`/`agent_disconnected` handlers reading `agents[id]`.
  - **Verify:** `cd frontend && npm run lint && npm run build`. Add a unit test if feasible.

- [x] **2.3 Add request cancellation to `useAgentActivitySessions`.**
  `frontend/src/hooks/useAgentActivitySessions.ts:158` — `loadActivityData` has no
  cancellation, so switching agents lands stale pages in the shared `rawRef`. Add a
  per-invocation request-id / `cancelled` flag (mirror `useResolvedAgentInfo.ts:14`); ignore
  late results and reset `rawRef` when `agentId` changes.
  - **Verify:** `cd frontend && npm run lint && npm run build`.

- [x] **2.4 Clear notification auto-dismiss timers.**
  `frontend/src/hooks/useNotifications.ts:48` — `setTimeout` is fire-and-forget. Store handles
  and clear them on manual dismiss and on unmount to stop post-unmount `setState`.
  - **Verify:** `cd frontend && npm run lint && npm run build`.

- [x] **2.5 Fix concurrent file-upload corruption on the agent.**
  `agent/src/server_command.rs:26` — `FILE_UPLOAD_SESSION` is a single global. Key upload
  sessions by an upload-id (or destination path) so two concurrent uploads don't truncate
  each other. Reject chunks whose upload-id doesn't match an open session.
  - **Verify:** from `agent/`: `cargo check`.

- [x] **2.6 [SECURITY] Block non-http(s) URLs from becoming clickable links.**
  `frontend/src/components/timeline/ActivityTimeline.tsx` — URL rows at `:479`/`:510` render
  `<a href={u.url}>` without a scheme check, allowing `javascript:` click-to-XSS. Gate every
  URL `<a>` on the existing `^https?:` test (already computed at `:525` for trigger text).
  - **Verify:** `cd frontend && npm run lint && npm run build`.

---

## Phase 3 — Performance

- [~] **3.1 Virtualize the activity timeline + cap retained pages.** (PARTIAL)
  `frontend/src/components/timeline/ActivityTimeline.tsx:1342` renders all day/session/row
  nodes; `frontend/src/hooks/useAgentActivitySessions.ts:221` concats 750×4 rows per page
  with no cap. Add `@tanstack/react-virtual` (or equivalent) for the session list and cap the
  number of retained pages/sessions in memory.
  - DONE: capped retained rows per stream (`MAX_RETAINED_ROWS_PER_STREAM` in the hook) so
    memory/DOM are bounded.
  - DEFERRED: virtualization of the collapsible day→session→row tree. It interacts with
    jump-to-highlight, infinite-scroll sentinel, and day collapse; doing it blind (no manual
    scroll verification available here) is too regression-prone. Needs a running app to verify.
  - **Verify:** `cd frontend && npm run lint && npm run build`; manual scroll check if running.

- [ ] **3.2 [BEHAVIOR] Batch telemetry event inserts.** (DEFERRED)
  `server/src/ws_agent.rs:704` writes N events sequentially per batch. Use a single multi-row
  `INSERT`. Keep the WS message shape unchanged.
  - DEFERRED: a naive multi-row INSERT changes existing semantics — `insert_window` also upserts
    a per-(app,title) focus counter, `upsert_keys` appends text to an open session, and
    `insert_url` skips consecutive duplicates (all order-dependent). Batches are also
    heterogeneous (mixed event types → different tables). A correct version needs DB
    integration tests, which aren't available in this environment.
  - **Verify:** `cargo check -p sentinel-server`, `cargo test -p sentinel-server`.

- [ ] **3.3 Diff software inventory in SQL, not memory.** (DEFERRED)
  `server/src/ws_agent.rs:521` pulls the full prior snapshot and diffs in memory on every
  report. Compute the diff with SQL (`INSERT ... ON CONFLICT` / `EXCEPT`) to avoid loading
  every row per snapshot.
  - DEFERRED: requires staging the incoming snapshot into a temp table and replicating the
    in-memory diff key (`lower(name)\nlower(version)\nlower(publisher)`) in SQL, then rewiring
    `replace_agent_software` + the change-event emission. Behavior-sensitive; needs DB
    integration tests not available here.
  - **Verify:** `cargo check -p sentinel-server`.

- [x] **3.4 Bound the in-memory frame cache.**
  `server/src/state.rs:79` retains one (up to 8 MiB) frame per agent with no global cap. Only
  retain frames for agents with active MJPEG viewers (the `capture_viewers` refcount already
  exists), and/or add a global memory cap with LRU eviction.
  - **Verify:** `cargo check -p sentinel-server`.

- [x] **3.5 Move blocking work off the agent's async runtime.**
  `agent/src/server_command.rs` — `save_config` (sync DPAPI + disk write) and per-chunk
  `sync_all()` fsync (`server_command.rs:956`) run on a 2-worker Tokio runtime, stalling
  telemetry. Wrap these in `tokio::task::spawn_blocking`.
  - Used `tokio::task::block_in_place` rather than `spawn_blocking`: `handle_server_command`
    is a sync fn on a `tokio::select!` branch (no async context to `.await` a join handle), and
    chunk writes must stay ordered. `block_in_place` hands other tasks to the second worker
    while keeping the work synchronous; the runtime is confirmed multi-threaded (2 workers).
  - **Verify:** from `agent/`: `cargo check`.

---

## Phase 4 — Tests (lock in the fixes above)

- [x] **4.1 Server unit tests for pure auth/security functions.** Cover the new trusted-IP
  logic (1.1), per-username lockout (1.2), lockout window math (`auth.rs:188`), CSRF compare,
  `sanitize_return_to`, enrollment-code normalization, and `map_role_from_groups` (1.5).
  None need a DB.
  - **Verify:** `cargo test -p sentinel-server`.

- [x] **4.2 Frontend unit tests for `session-aggregator.ts`.** It's pure and central
  (`aggregateSessions`, `redistributeUrlsToBrowserSessions`, `attachAlertEventsToSessions`).
  Add Vitest cases. Also cover `ApiError` parsing in `lib/api.ts` and the live-status merge
  helper from 2.2.
  - **Verify:** `cd frontend && npm test`.

---

## Phase 5 — Architecture & maintainability (larger; do last, one module at a time)

- [x] **5.1 Split `server/src/db.rs` (4,700 lines / ~160 fns) into a `db/` facade.**
  Carve into `db/{users,sessions,enrollment,telemetry,blocking,categorization,audit}.rs`
  re-exported from `db/mod.rs`. Pure mechanical moves per commit; no behavior change. Pick one
  data-access convention and note it (handlers calling `db::` vs inline SQL like
  `api/scheduled_scripts.rs`).
  - DONE: `db.rs` → `db/mod.rs` plus submodules `agents`, `agent_groups`, `alert_rules`,
    `app_block`, `internet_block`, `software`, `telemetry`, `queries`, `users_sessions`, each
    `pub use`d so every existing `db::<fn>` call site is unchanged (facade). `mod.rs` keeps the
    shared prelude (`pub(crate) use`), shared helpers (`sha256_hex`, `unix_to_dt`,
    `pg_is_unique_violation`, …), retention, agent settings, and the unit tests. Largest module
    is now 834 lines vs the original 4,720. Convention kept: handlers call `db::` functions.
  - **Verify:** `cargo check -p sentinel-server`, `cargo test -p sentinel-server` after each move.

- [~] **5.2 Replace silent `unwrap_or_default()` row reads in `db.rs`.** (PARTIAL) e.g.
  `list_agents` fabricates `Utc::now()` for a failed `first_seen` read (`db.rs:1762`).
  Propagate with `?` or use `FromRow` derive so schema drift fails loudly. Do this
  opportunistically while splitting in 5.1.
  - DONE: fixed the cited `list_agents` example to propagate row-read errors with `?`.
  - DEFERRED: the pattern recurs at ~50 sites across `db.rs`; the task says to do it
    "opportunistically while splitting in 5.1", which is deferred (see 5.1). A blanket sweep
    changes error behavior (one bad row would fail a whole request) and is best paired with the
    module split + tests.
  - **Verify:** `cargo check -p sentinel-server`.

- [ ] **5.3 Decompose `agent/src/server_command.rs` (998-line match) and `service.rs`.** (DEFERRED)
  Extract `fs_ops`, `process_ctrl`, `script`, `capture_ctrl` modules from
  `handle_server_command`; extract `handle_updater_pipe_request` / `handle_agent_ipc_session`
  and a `reply_err` helper from `run_service` (`service.rs:354-705`). No behavior change.
  - DEFERRED: large mechanical decomposition of the agent's critical command/IPC paths,
    verifiable here only by `cargo check` (no on-box runtime test). Deferred to a focused
    follow-up to avoid blind regressions in remote-control/IPC behavior.
  - **Verify:** from `agent/`: `cargo check`.

- [x] **5.4 Confirm and remove dead frontend code.** (premises re-verified — see notes)
  - `NotificationsAdminPage.tsx`: NOT dead after re-verification — it is still reachable via
    `/groups` (`AuthenticatedGroups` → `NotificationsAdminPage mode="groups"`). Kept.
  - `agentInfoReceivedAtMs`: NOT unused after re-verification — it is consumed in
    `lib/cards-config.tsx:59` and `components/overview/AgentCard.tsx`, including the current
    uncommitted working-tree changes. Kept (removing it would break live code).
  - REMOVED: `routes/AuthenticatedNotifications.tsx` — a genuinely dead route wrapper
    (`/notifications` redirects to `/rules`, and this wrapper was imported nowhere).
  - **Verify:** `cd frontend && npm run lint && npm run build` (build fails on broken imports).

- [~] **5.5 Decompose `RulesPage.tsx` (1,927 lines) into per-tab components** and introduce a
  shared `useAsync`/`useApiResource` hook (`{data, loading, error, reload}`) to replace the
  duplicated `loading/error/load` soup; route error rendering through `isApiError`
  (`api.ts:52`) instead of `setError(String(e))`. (PARTIAL)
  - DONE: added `errorText(e)` (uses `isApiError`/`Error.message`) in `lib/api.ts` and routed all
    16 `setError(String(e))` sites in `RulesPage.tsx` through it, so the UI shows clean API error
    messages instead of `"Error: …"`/`"[object Object]"`. Unit-tested.
  - DEFERRED: the per-tab component decomposition + shared `useAsync` hook is a large UI refactor
    introducing a new pattern; `AGENTS.md` cautions against broad refactors / new frameworks, and
    it needs manual UI verification. Left for a focused follow-up.
  - **Verify:** `cd frontend && npm run lint && npm run build`.

- [ ] **5.6 Move cross-cutting dashboard props to React Context.** (DEFERRED)
  `App.tsx:111-444` prop-drills ~12 identical nav/notification/user props through every route
  wrapper. Put session user, notifications, and tools-panel state into context consumed by
  `DashboardLayout`.
  - DEFERRED: a broad refactor across every route wrapper; it would also need to edit
    `DashboardLayout.tsx`, which currently has uncommitted user WIP. Deferred to avoid
    conflicting with in-progress work and per `AGENTS.md`'s caution on broad refactors.
  - **Verify:** `cd frontend && npm run lint && npm run build`.

---

## Lower-priority notes (address opportunistically, not required)

- Distinguish FK/unique-violation `sqlx` errors → 400/409 instead of blanket `err500`
  (`server/src/error.rs`, `api/scheduled_scripts.rs`).
- `view_audit_log` writes an audit row on every read (`api/audit.rs:52`) — self-referential
  growth; consider not auditing reads.
- Per-agent scoping for operators (`ws_viewer.rs:161`, `agents_capture.rs:80`): operator =
  full-fleet access today; document or gate by group membership.
- Verify the updater `pk.verify(..., false)` prehash flag matches Tauri's signing
  (`agent/src/updater_client.rs:67-68` — comment contradicts the arg).
- Add a client-side cap to `agentLogTail` text (`frontend/src/lib/api.ts:712`).
- Give real response types to audit/alert-event endpoints returning
  `Record<string, unknown>[]` (`api.ts:704/954/968/977`) and drop the
  `as unknown as AlertRuleScope[]` double-cast (`RulesPage.tsx:85`).
