# Sentinel Enrollment Redesign Brief

Use this brief to implement a new agent enrollment flow for Sentinel.

## Goal

Replace the current "6-digit code directly enrolls agent" flow with a local-network pairing model:

- Agents discover the server with mDNS.
- Agents create a pending enrollment claim.
- Admins approve or reject claims in the dashboard.
- Approved agents receive a per-device credential and then connect normally.
- 6-digit codes remain as a fallback when mDNS discovery fails, but they should create a pending claim rather than immediately trusting the device.
- Agent-to-server runtime auth must use claim-issued per-device credentials only. Remove password/shared-secret auth paths.

The target users usually do not have MDM. Optimize for manual installs, homelabs, small offices, schools/labs, and family-managed PCs.

## Current Flow

Relevant files:

- `server/src/agent_enroll_http.rs`
- `server/src/api/agent_enrollment.rs`
- `server/src/db.rs`
- `server/src/ws_agent.rs`
- `agent/src/enrollment.rs`
- `agent/src/config.rs`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/components/overview/AddAgentModal.tsx`
- `frontend/src/lib/api.ts`

Current behavior:

1. Admin creates a 6-digit enrollment code.
2. Agent posts `enrollment_token` and `agent_name` to `POST /api/agent/enroll`.
3. Server immediately creates/updates the agent with an API token.
4. Agent stores that token and uses it for WebSocket auth.

Keep the per-agent token model, but change how a device reaches the trusted state.

## Breaking Auth Decision

This redesign may break existing installs. That is acceptable.

Remove password-style and shared-secret agent authentication entirely:

- Remove `AGENT_SECRET`.
- Remove `ALLOW_INSECURE_AGENT_AUTH`.
- Remove shared-secret fallback in `/ws/agent`.
- Remove any unauthenticated/insecure agent WebSocket mode.
- Rename agent config semantics from `agent_password` to `agent_token`.
- Do not allow agent name + password/secret to imply trust.
- Do not keep direct enrollment as a trusted path.

Keep only this runtime auth model:

1. Fresh agent has no trusted runtime credential.
2. Fresh agent can only call enrollment claim/polling endpoints.
3. Admin approves the claim.
4. Server generates a high-entropy per-device agent token.
5. Server stores only a hash of that token.
6. Agent stores the token locally using the existing DPAPI-protected config path.
7. Agent connects to `/ws/agent` with `Authorization: Bearer <agent_token>`.
8. Server accepts only valid per-device tokens.

Important: a claim id is not a credential. Approval must generate a separate secret token that is returned once to the polling agent.

## Desired Product Flow

### Default: Local Pairing

1. User installs and opens the Windows agent.
2. Agent discovers Sentinel server via mDNS.
3. Agent displays the discovered server name/address and a server fingerprint if available.
4. User clicks `Request access`.
5. Agent sends a claim request to the server.
6. Dashboard shows a pending agent claim with:
   - requested display name
   - hostname
   - Windows username if available
   - local IP/client IP
   - OS/version
   - agent version
   - first seen time
   - server/discovery source
7. Admin approves, optionally renames and assigns group/policy.
8. Agent receives a per-device token, stores it with existing DPAPI config behavior, and connects to `/ws/agent`.
9. All future WebSocket connections require that per-device token.

### Fallback: Pairing Code

Use when mDNS fails or the user manually enters server URL:

1. Admin creates a short-lived 6-digit pairing code.
2. Agent enters code and server URL.
3. Agent creates a pending claim.
4. Admin approves claim.
5. Agent receives/stores per-device token.

The code should not directly create a trusted agent unless the invite explicitly allows auto-approval.

### Recovery/Re-enroll

Support later, or leave clear hooks:

1. Admin selects existing agent.
2. Admin creates a one-use re-enrollment invite bound to that agent.
3. New install claims that existing identity.
4. Old credential is revoked/replaced.

## Data Model

Add migrations for new tables. Do not rewrite old migrations.

### `agent_enrollment_invites`

Suggested columns:

- `id UUID PRIMARY KEY`
- `secret_digest TEXT NOT NULL UNIQUE`
- `kind TEXT NOT NULL` values: `quick_pair`, `unattended`, `re_enroll`
- `uses_remaining INTEGER NOT NULL`
- `expires_at TIMESTAMPTZ`
- `auto_approve BOOLEAN NOT NULL DEFAULT false`
- `default_group_id UUID`
- `bound_agent_id UUID`
- `created_by TEXT`
- `note TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `revoked_at TIMESTAMPTZ`

For now, `quick_pair` is the main path. `unattended` can exist for future use but is not the primary UX.

### `agent_enrollment_claims`

Suggested columns:

- `id UUID PRIMARY KEY`
- `invite_id UUID`
- `status TEXT NOT NULL` values: `pending`, `approved`, `rejected`, `expired`
- `requested_name TEXT NOT NULL`
- `hostname TEXT`
- `os TEXT`
- `agent_version TEXT`
- `install_id_digest TEXT`
- `client_ip TEXT`
- `discovered_server TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `approved_by TEXT`
- `approved_at TIMESTAMPTZ`
- `rejected_by TEXT`
- `rejected_at TIMESTAMPTZ`
- `agent_id UUID`
- `error TEXT`

Recommended uniqueness:

- Prevent multiple active pending claims for the same `install_id_digest`.
- Do not let a claim overwrite an existing enrolled agent unless using a bound re-enroll invite.

## API Design

### Public/rate-limited agent endpoints

Add under `/api/agent/enrollment/...`.

#### `POST /api/agent/enrollment/claims`

Creates or refreshes a pending claim.

Request:

```json
{
  "pairing_code": "123456",
  "requested_name": "DESKTOP-123",
  "hostname": "DESKTOP-123",
  "os": "Windows 11",
  "agent_version": "0.1.6",
  "install_id": "locally-generated-stable-random-id",
  "discovered_server": "Sentinel Home"
}
```

Notes:

- `pairing_code` may be optional for trusted local-discovery mode only if you intentionally add that policy. Safer first version: require either a valid pairing code or a server-created open pairing window.
- Store only a digest of `install_id`.
- Return a claim id and polling interval.

Response:

```json
{
  "claim_id": "uuid",
  "status": "pending",
  "poll_after_secs": 2
}
```

#### `GET /api/agent/enrollment/claims/:id`

Agent polls status.

Response while pending:

```json
{
  "status": "pending",
  "poll_after_secs": 2
}
```

Response when approved:

```json
{
  "status": "approved",
  "agent_id": "uuid",
  "agent_token": "secret-shown-once",
  "agent_name": "Approved Name"
}
```

Response when rejected:

```json
{
  "status": "rejected",
  "error": "Rejected by admin"
}
```

### Admin dashboard endpoints

Add under existing protected `/api/settings/...` routes.

#### `GET /api/settings/agent-enrollment-claims`

List pending/recent claims.

#### `POST /api/settings/agent-enrollment-claims/:id/approve`

Request:

```json
{
  "agent_name": "Office PC 01",
  "group_id": "optional-uuid"
}
```

Behavior:

- Create an `agents` row or attach to `bound_agent_id` for re-enroll.
- Generate a high-entropy per-agent token.
- Store only an Argon2 hash of token, matching current `api_token_hash` behavior.
- Mark claim approved.
- Return success to dashboard. The agent receives token via polling.

#### `POST /api/settings/agent-enrollment-claims/:id/reject`

Mark claim rejected.

#### Existing invite/code endpoints

You can either replace or adapt existing endpoints:

- `POST /api/settings/agent-enrollment-tokens`
- `GET /api/settings/agent-enrollment-tokens`
- revoke/list uses endpoints

Better naming for UI/API long term:

- `pairing codes`
- `pending agents`
- `approved agents`

But keep backward-compatible route aliases if practical.

## Agent Changes

Relevant file: `agent/src/enrollment.rs`.

Agent should support:

1. Discover server via current mDNS mechanism.
2. Generate and persist a stable local `install_id` before enrollment.
3. Create a claim instead of directly asking for `agent_token`.
4. Poll claim status.
5. On approval, save:
   - server URL
   - approved agent name
   - per-agent token as `agent_token`
6. Delete one-time enrollment/pairing files only after success or definite rejection/expiry.
7. Stop using the old `agent_password` name in new config/code. Add one migration shim only if needed to read and rewrite old config once.

Important UX states:

- `No server found`
- `Server found`
- `Requesting approval`
- `Waiting for admin approval`
- `Approved`
- `Rejected`
- `Code expired`
- `Already enrolled`

## Dashboard Changes

Add a pending claims panel to the existing Add Agent modal and Settings enrollment area.

Admin should be able to:

- See pending claims live or via refresh.
- Approve claim.
- Rename before approval.
- Assign group if groups exist.
- Reject claim.
- Revoke active pairing codes.

Primary copy:

- Use `Local pairing`, `Pending agents`, `Approve device`.
- Avoid enterprise-heavy wording like MDM-first enrollment.

## Security Requirements

- Public claim endpoints must be rate-limited.
- Store invite secrets and install ids as digests only.
- Pairing codes:
  - 6 digits
  - 1 use by default
  - 10 minute default expiry
  - create pending claims by default
- Long/bootstrap invites, if implemented:
  - 128+ bits entropy
  - shown once
  - revocable
  - optionally auto-approve
- Never let requested agent name be identity. Use UUID identity.
- Never overwrite an enrolled agent by name.
- Runtime WebSocket auth must always require a valid per-device bearer token.
- There must be no shared server-wide agent secret fallback.
- There must be no insecure agent auth mode.
- Audit:
  - invite/code creation
  - claim creation
  - approval
  - rejection
  - credential issuance
  - credential reset/revoke

## Implementation Steps

1. Add DB migrations for invites and claims.
2. Add DB helpers in `server/src/db.rs`.
3. Add public claim/poll endpoints.
4. Add admin list/approve/reject endpoints.
5. Change `/ws/agent` auth to require per-device bearer tokens only.
6. Remove `AGENT_SECRET` / `ALLOW_INSECURE_AGENT_AUTH` config and docs.
7. Rename agent config field usage from password-style naming to `agent_token`.
8. Update agent enrollment code to create/poll claims.
9. Update dashboard Add Agent modal with pending claims.
10. Delete old direct enrollment behavior, or make the old route return `410 Gone` with a migration message.
11. Add tests for:
   - expired code rejected
   - invalid code rejected
   - valid code creates pending claim
   - approval creates agent token
   - duplicate pending claim behavior
   - existing enrolled agent cannot be overwritten by name
   - WebSocket rejects missing bearer token
   - WebSocket rejects old shared-secret/password auth
   - WebSocket accepts approved per-device token

## Acceptance Criteria

- A fresh agent can discover the server, request access, wait pending, then connect after dashboard approval.
- A 6-digit code creates a pending claim rather than immediately trusted enrollment.
- Admin can approve/reject claims from dashboard.
- Approved agent gets a per-device token and uses existing WebSocket auth.
- Agent WebSocket auth no longer accepts `AGENT_SECRET`, `ALLOW_INSECURE_AGENT_AUTH`, or password-style credentials.
- Existing enrolled agents continue to connect.
- Existing enrolled agents may require a one-time config migration from `agent_password` naming to `agent_token` naming.
- Existing enrollment codes may be invalidated; breaking this flow is acceptable.
- No plaintext enrollment secrets are stored server-side.
- All new sensitive actions are audited.
