# vantyr-network-runtime

Worker-local building blocks shared by the Vantyr Network protocol workers.

## Typed last-known-good persistence

`TypedLkgStore<T, V>` keeps one typed payload in one file. It was generalised
from the original policy-only store; `LkgStore<V>` and `LkgSnapshot` remain as
policy-only aliases so existing callers and their tests are unchanged.

- `Persistable` supplies `revision()`, `household_id()` and shape checks for a
  payload. `Policy` has an implementation; a DNS worker supplies its complete
  config+policy `Bundle` as another.
- `Validator<T>` is the "can this worker enforce it?" seam. `PolicyValidator`
  and its closure implementation are retained and bridged to
  `Validator<Policy>`.
- `TypedSnapshot<T>` carries schema, immutable household and worker ids, a
  monotonic `highwater`, the payload and `saved_at`. The field name `policy`
  is kept for source compatibility; for a generic store it holds that store's
  typed payload.
- `open` requires an expected household; `open_from_snapshot` takes the
  household from an existing file and still checks schema, worker, high-water
  and payload rules. A missing file is `LkgError::Missing`, never an implicit
  empty store that a caller could overwrite.

Ordering: a candidate is validated, written to a same-directory temp file
(mode `0600`, `sync_all`), then atomically renamed; only after the rename does
in-memory state advance. A failure before the rename leaves the previous file
and memory intact. Hooks around the rename are injectable for tests.

### Durability contract

A successful `apply` survives a **process restart**. It does not claim
survival of sudden power loss: the post-rename parent-directory sync is best
effort and its failure is deliberately not returned once the rename committed.
The parent directory is trusted; a process able to write it can forge state.
This is local durability, not controller authentication — there is no
signature, MAC or hash claiming controller origin, and no canary/verified
claim.

## Bounded events

`EventQueue` keeps a household-scoped queue with configurable count, byte,
per-event, retention and future-skew bounds, validated on creation and update.
Reads and stats prune expired records so an idle queue never exposes them.
Free-text fields resembling URLs, credentials or bodies are refused at ingest.
Records are kept separate by source/evidence/correlation id; nothing is
deduplicated or aggregated into a fabricated "visit".

## Tests

`cargo test -p vantyr-network-runtime` covers the original 22 policy/event
contracts plus a typed non-policy payload using the same store protocol.
The shared policy package name has not changed; this crate reaches it through
the `vantyr-network-policy` manifest alias.
