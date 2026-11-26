# Network management read contracts

This document is the exact contract for the bounded browser read slice. All
routes are mounted under `/api` and inherit the existing OIDC session-cookie
middleware. They are **GET only**, so CSRF is not required; a valid session
cookie is. No worker Bearer credential is accepted on any of them, and no
handler writes policy state, assigns a gateway, acknowledges or enforces
anything. No applied/enforced flag exists in this slice.

Saved policies remain **proposals**. `body_sha256` is a SHA-256 content digest
of the exact stored bytes — an integrity check, not a signature, not proof of
worker verification, and never a secret.

## 1. Policy body reads (admin only)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /api/network/households/{hid}/policies/current` | explicit `network_admin` on `hid` | The newest **saved** revision (`MAX(revision)`), never a desired assignment or an applied/verified state. |
| `GET /api/network/households/{hid}/policies/{revision}` | explicit `network_admin` on `hid` | Exact immutable revision in **this** household. |

The literal segments `current` and `diff` are registered before `{revision}`, so
they are never parsed as a revision. `{revision}` must be `1..=i64::MAX`; a
non-numeric, zero, negative or overflowing value is `400`. A missing, pruned or
foreign revision is `404`. An unsupported stored schema, a digest mismatch, an
unparseable body or a body whose `household_id`/`revision` disagree with the row
is an honest `404` — never served as valid policy.

Response `200` envelope:

```json
{
  "policy": {
    "household_id": "uuid",
    "revision": 2,
    "schema_version": 1,
    "source_kind": "publish",
    "rolled_back_from_revision": null,
    "published_at": "RFC3339",
    "published_by": "uuid|null",
    "body_sha256": "64 lowercase hex chars",
    "body_bytes": 1234,
    "policy": { "...": "the stored core vantyr_network_policy::Policy" }
  }
}
```

`policy.policy` is the typed core model decoded from the exact bytes covered by
`body_sha256`: `household_id`, `revision`, `baseline`, `device_profiles`,
`person_rules`, `exceptions`, `default_effect`, `timezone`, `stale_after_secs`,
`event_retention_secs`, `published_at`. The row's `published_at` comes from
`timestamptz` (microseconds) while the body carries the full serde timestamp;
they describe the same instant. The body is bounded to 64 KiB by migration 0077
and checked again on read. Reads do not create audit rows or change any policy
or desired-assignment row.

Platform roles alone, `network_events`, `network_enroll`, and grants on another
household all return `403` (no scope probing). Unauthenticated requests return
`401`.

## 2. Semantic policy diff (admin only)

`GET /api/network/households/{hid}/policies/diff?from_revision=N&to_revision=M`

Both parameters are required positive integers `1..=i64::MAX`; unknown query
fields, missing parameters and malformed values are `400`. Both revisions must
exist in this household (a pruned or foreign source is `404`). Same revision is
a valid, empty content diff (the row is still fetched and validated).

Response `200` envelope:

```json
{
  "diff": {
    "household_id": "uuid",
    "from": { "revision": 1, "schema_version": 1, "source_kind": "publish",
              "rolled_back_from_revision": null, "published_at": "RFC3339",
              "body_sha256": "hex" },
    "to":   { "revision": 2, "schema_version": 1, "source_kind": "publish",
              "rolled_back_from_revision": null, "published_at": "RFC3339",
              "body_sha256": "hex" },
    "content_changed": true,
    "settings": [
      { "field": "timezone", "before": "Australia/Sydney", "after": "UTC" }
    ],
    "rules": [
      { "scope": "baseline", "id": "r1", "change": "changed",
        "before": { "...": "core Rule" }, "after": { "...": "core Rule" } }
    ],
    "counts": {
      "added_rules": 1, "removed_rules": 0, "changed_rules": 1,
      "changed_settings": 1, "total_rules_from": 2, "total_rules_to": 2
    },
    "truncated": false,
    "omitted_changes": 0
  }
}
```

- `scope` is `baseline` or the device-profile name; `change` is `added`,
  `removed` or `changed`. `before`/`after` are the **core `Rule`** values, not a
  second model. Rules are keyed by `(scope, id)` and emitted in sorted order.
- Comparable settings: `default_effect`, `timezone`, `stale_after_secs`,
  `event_retention_secs`, `person_rules`, `exceptions`.
- Revision, `source_kind`, rollback provenance, `published_at` and digest live
  only in `from`/`to`. A rollback that copies an earlier body therefore yields
  `content_changed: false` even when the new revision and digest differ.
- Caps: 512 rule changes and 16 setting changes per response. Counts always
  describe the full diff; if a cap is hit, `truncated: true` and
  `omitted_changes` report exactly what was left out. Input bodies are already
  capped at 64 KiB, so no unbounded recursive work is possible.

This is a deterministic semantic summary, **not** an RFC 6902 patch protocol:
there are no `op`/`path` fields and nothing here can be replayed as a write.

## 3. Household audit (admin only, compatible extension)

`GET /api/network/households/{hid}/audit`

The previous `{ "rows": [...] }` field and ordering (`ts DESC, id DESC`) are
unchanged. Additive query parameters:

| Parameter | Validation |
| --- | --- |
| `action` | exact match, 1..=128 chars, no control characters |
| `actor` | exact match on the **stored string** (not parsed as a user UUID), 1..=128 chars, no control characters |
| `from`, `to` | RFC3339 instants, inclusive; `from > to` is `400` |
| `limit` | 1..=1000, default 50 |
| `offset` | 0..=100000, default 0 |

Unknown query fields are `400`. `network_events` alone is `403`; there is no
global audit fallback and no cross-household rows.

Response `200`:

```json
{
  "rows": [ { "id": 1, "ts": "RFC3339", "household_id": "uuid",
              "actor": "string", "client_ip": "string|null",
              "action": "network_policy_publish", "status": "ok",
              "detail": {} } ],
  "total": 3,
  "has_more": true,
  "next_offset": 2
}
```

`total` and `rows` use the identical parameterised tenant + filter predicates
inside one `REPEATABLE READ` snapshot, so a concurrent insert cannot make the
count contradict the page. `next_offset` is `null` when `has_more` is false.

## 4. Self-service enrollment contexts (caller only)

`GET /api/network/enrollment-contexts`

No `hid` in the path: this is **not** administrative household discovery. The
query requires, for the current OIDC `AuthUser` only, BOTH an exact
`network_enroll` grant and an active, non-revoked admin-created principal
binding in the same household. Revoking either removes the context immediately;
a re-map bumps the reported `generation`. A user with only `network_admin`,
only `network_events`, or no grant gets an empty list (not `403`, so the route
cannot be used to probe another user's scope). `limit`/`offset` use the same
bounds as above; malformed page parameters are `400`.

Response `200`:

```json
{
  "contexts": [
    { "household_id": "uuid", "household_name": "Home",
      "person_id": "uuid", "person_display_name": "Teen",
      "binding_id": "uuid", "generation": 1 }
  ],
  "count": 1,
  "total": 1,
  "has_more": false,
  "next_offset": null
}
```

Only the caller's household id/name and the mapped person display are returned.
No devices, other persons, grant lists, inventory, other users, secrets or
network-identity claims are included. An enroll-only user still gets `403` on
`GET /api/network/households/{hid}/devices` and on policy reads.

## 5. Additive display labels on existing enrollment reads

These fields were added to already-scoped rows for the frontend; they are pure
projections from joins inside the same household and introduce no new identity
source. Existing fields and envelopes are unchanged.

- `GET /api/network/households/{hid}/bindings` (still `network_admin` only) —
  each row additionally carries `dashboard_username`,
  `dashboard_display_name` and `person_display_name`. These come from the
  dashboard user explicitly named by the admin when the binding was mapped and
  that household's person row; they are labels, never proof of who is present.
- `GET /api/network/households/{hid}/enroll/sessions` (caller's own binding
  only) — each row additionally carries `person_display_name`, the label of the
  person bound to the **caller's** binding in that household. It is not inferred
  from a device, IP, MAC or self-asserted profile.

## Tests and limits

`server/src/network/read_tests.rs` uses fresh `#[sqlx::test]` databases and real
HTTP sessions: exact stored bytes/digest/model and no side effects, malformed
and foreign/pruned revisions, semantic diff including rollback provenance,
audit filters/count/paging/order and invalid input, own-context isolation plus
grant/binding revocation and generation bumps, and the additive scoped labels.
`server/src/network/read_dto.rs` has pure validation/diff unit tests. Run with
`SQLX_OFFLINE=true cargo test -p vantyr-server --locked` against a throwaway
PostgreSQL (see [testing.md](testing.md)).
