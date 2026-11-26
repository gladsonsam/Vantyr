# Network management mutations

Bounded configuration edits, conservative inventory deletes and atomic
default-profile selection for the household UI. All routes live under `/api`,
require an OIDC session cookie **and** a valid CSRF token (PATCH/DELETE), and
require an explicit `network_admin` grant on the household in the URL. Platform
roles, `network_events` and `network_enroll` never authorize these routes. The
grant is re-checked inside the same household-locked transaction as the write,
so a concurrent grant revocation cannot leave a stale authorized commit.

Ids come only from the path. Request bodies are strictly typed and reject
unknown fields; an absent field means "keep unchanged". Nothing here publishes
a policy, assigns a desired revision, changes a worker credential's secret,
revives a revoked gateway, grants a platform privilege or claims that a gateway
is enforcing or protected.

## 1. Household configuration

`PATCH /api/network/households/{hid}`

```json
{ "name": "Renamed Home", "timezone": "Australia/Melbourne" }
```

- `name`: optional, non-blank after trim, ≤120 chars, no control characters.
- `timezone`: optional, valid IANA name (≤64 chars), normalised to its canonical
  name.
- `{}` and unknown fields → `400`. An edit whose values equal the stored values
  returns `200` with `changed_fields: []` and writes no audit row.
- Changing `timezone` is **recorded configuration only**: the immutable policy
  rows, their digests, desired assignments and worker enforcement state are
  untouched. There is no implicit re-publish.

Response `200`:

```json
{
  "household": { "id": "uuid", "name": "Renamed Home",
                 "timezone": "Australia/Melbourne", "is_default": false,
                 "created_at": "RFC3339" },
  "changed_fields": ["name", "timezone"]
}
```

Audit: `network_household_update` with only `changed_fields` — no secrets.

## 2. Gateway label / enabled

`PATCH /api/network/households/{hid}/gateways/{gid}`

```json
{ "label": "Front Door DNS", "enabled": false }
```

- `label`: optional, non-blank ≤120 chars. `enabled`: optional boolean.
- `{}`, unknown fields, blank label → `400`. Missing/foreign gateway → `404`.
- **Disable** writes only `enabled = false`; credentials keep their expiry,
  revocation timestamps, audience and command scopes. The existing worker auth
  lookup selects `g.enabled` and `g.revoked_at` from the locked gateway row, so
  both `/worker/network/policy/read` and `/worker/network/gateway/heartbeat`
  fail with `401` as soon as the PATCH commits.
- **Re-enable** writes `enabled = true` only when `revoked_at IS NULL`, both in
  the service and in the UPDATE predicate. A revoked gateway returns `409` and
  cannot be revived; its credentials remain revoked. Use `DELETE` (revocation)
  is irreversible by design.
- A revoked gateway's label may still be edited; its `enabled` stays false.
- `enabled` does **not** mean applied, enforced or protected. The response has
  no such fields.

Response `200`: `{ "gateway": <Gateway>, "changed_fields": ["label","enabled"] }`.
Audit: `network_gateway_update` with `gateway_id` and `changed_fields`.

All gateway mutators keep the existing global `household -> gateway -> credential`
lock order, so disable/re-enable cannot race heartbeat, rotate or revoke.

## 3. Conservative deletes

Routes (all `DELETE`, `network_admin` on `hid`):

- `/api/network/households/{hid}/persons/{pid}`
- `/api/network/households/{hid}/devices/{did}`
- `/api/network/households/{hid}/assignments/{aid}`
- `/api/network/households/{hid}/connections/{cid}`

Response `200`: `{ "ok": true, "kind": "person"|"device"|"assignment"|"connection", "id": "uuid" }`.
A repeat, a missing id or an id from another household returns `404` without
revealing whether the object exists elsewhere.

Every mutator locks the household, locks the target row `FOR UPDATE`, recounts
references in the same transaction, and only then deletes. A concurrent FK
insert takes `FOR KEY SHARE` on the parent row and therefore blocks until the
decision commits — a household lock alone is not sufficient, and no cascade is
relied upon. Assignment and connection create/PATCH also map a foreign-key
failure after a concurrent delete to `409`, without exposing constraint details;
the caller must reload the referenced inventory. Refusals are `409` with a short
message (<160 chars),
never `500`, and leave every row and every audit entry intact.

| Object | Blocks deletion (any status/history, including revoked/ended/inactive) |
| --- | --- |
| Person | `network_assignments` (cascade), `network_principal_bindings` (cascade, incl. revoked/re-mapped history), `network_enrollment_grants`, `network_verified_sessions` |
| Device | `network_assignments`, `network_connections` (both cascade), `network_device_enrollments` (incl. `ended`), `network_enrollment_grants`, `network_verified_sessions` |
| Assignment | `network_connections` referencing it (cascade) |
| Connection | `status = 'active'`; an admin must first PATCH it to `inactive`/`revoked`. Deleting it has no worker side effect. |

Checked FKs (migrations 0073/0074/0077/0078): persons → households (cascade) and
the composite `(person_id, household_id)` FKs from assignments and principal
bindings (cascade); devices → household (cascade) with composite FKs from
assignments, connections, device enrollments, enrollment grants and verified
sessions (cascade); assignments → connections (cascade); gateways → credentials
and reports (cascade). Policy versions, desired assignments, `network_audit`,
enrollment attempts and dashboard audit are **not** cascaded by any of these
deletes. Household deletion and agent un-enrolment are deliberately out of this
slice; no broad soft-delete machinery was introduced.

Audit actions: `network_person_delete`, `network_device_delete`,
`network_assignment_delete`, `network_connection_delete`.

## 4. Atomic default profile

Existing person create/PATCH now run through the same household-locked
transaction:

1. lock household; re-check `network_admin`;
2. lock the target person `FOR UPDATE` (PATCH) and prove it is in this household;
3. clear other defaults, then set the target — inside the same transaction;
4. apply name/note changes and commit.

A missing or foreign target returns `404` and leaves the current default
unchanged. Two concurrent `is_default_profile: true` requests both complete
`200` with at most one final default; the partial unique index still enforces
the invariant. Zero defaults remains legal. The accepted nullable PATCH
semantics are preserved: omission keeps a note, explicit `null` clears it.

## Tests

`server/src/network/mutation_tests.rs` runs real HTTP against fresh
`#[sqlx::test]` databases: household validation/scoping and policy untouched,
disable/re-enable vs irreversible revoke and worker 401s, each referenced-delete
refusal with rows/audits intact, unreferenced success/repeat 404, active
connection refusal, a concurrent FK insert blocked by the target lock, and
default-profile concurrency with missing-target preservation. Verified with
`SQLX_OFFLINE=true cargo test -p vantyr-server --locked`, `cargo fmt --all --check`
and scoped `cargo clippy -p vantyr-server --all-targets --locked --no-deps -- -D warnings`.
