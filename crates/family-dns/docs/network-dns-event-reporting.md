# Worker DNS event reporting (opt-in)

Status: **production CLI and durable event integration independently reviewed; parent cancellation-accounting fix verified.** This slice adds a producer for the accepted server route `POST /worker/network/dns/events` (`server/docs/network-dns-events.md`, migration `0081`). It does not configure a worker, publish policy, change management revisions, claim enforcement, or create a UI. No proxy/agent ingestion, no public provider, no host/router DNS, no CA-trust change and no deploy is involved.

## Opt-in inputs

Reporting is OFF unless the caller supplies all of:

| Input | Shape | Custody |
| --- | --- | --- |
| options file | bounded JSON (`<=16 KiB`), `deny_unknown_fields` | owner-private `0600`, regular non-symlink file |
| bearer file | one `Bearer <id>.<secret>` line (`<=128` bytes) | owner-private `0600`, never a CLI argument |
| CA PEM (optional) | bounded PEM, merged into the trust store | owner-private `0600`; chain + hostname verification stay on |

Options: bare `https` origin (no path/userinfo/query/fragment), `household_id`, `gateway_id`, bounded `flush_interval_secs`, `max_batch` (1..=256), `request_timeout_secs`, `max_response_bytes`, `queue_capacity` (1..=4096), `backoff_secs`, `max_backoff_secs`. Plain HTTP, an unbounded origin or an out-of-range bound fails before any listener starts. The command is always the explicit `report_dns_events` (kind `dns`); an existing heartbeat/read credential is never upgraded by this code.

Transport: verified HTTPS only, `no_proxy()`, `redirect(none())`, bounded request body (256 KiB) and response body, no insecure certificate verifier. 401/403 is a permanent auth denial; 4xx and malformed/integrity failures are terminal for that batch; transport/5xx/429 get exactly one bounded retry. Errors never contain the bearer, a body or a response body.

## What is emitted

One observation per query, captured by a drop-guard in the query handler after the final decision — including alias-chain denial and response shaping. The observation is a **worker observation of a DNS query**, never a person action: there is no person id, verified/enforced flag, URL, path, body, header or secret. Fields:

- `name`: query name only, lower-cased, root dot stripped, domain-shaped and free of URL/control/secret markers.
- `query_type`: the server allowlist; an unsupported RR is counted as `invalid` and dropped individually, never batched.
- `protocol`: `udp`/`tcp` from hickory's `Request::protocol()`; anything else is `unknown`, never guessed.
- `flags`: `rd`/`cd`/`ra`/`ad` from the actual request metadata.
- `device_id`: only when the local config maps the source IP to a device **and** the server confirms an inventory assignment for that UUID in this household. Unmapped sources stay `null`; no UUID is fabricated.
- `reason_code`, `applied_rule`, `filter_*`: the policy/filter engine's actual conclusion. Alias denial carries `denied_alias_target` and the alias decision's reason/revision.
- `upstream`: always absent. The maintained resolver does not expose the answering upstream; inventing one would be dishonest.
- `cache_state`: always `"unknown"` (migration `0084`). The maintained resolver's cache use is unobservable from the decision layer; claiming `bypass` on a cached answer would be false. No hit/miss is fabricated and `upstream` stays null.
- `policy_revision`: the revision actually evaluated.

## Durability contract (explicit, no fake guarantee)

The event channel is a bounded in-memory FIFO with a declared loss strategy: when full it drops the **incoming** event and increments `lost_queue`; the oldest retained observations survive. Counters: `emitted`, `lost_queue`, `invalid`, `sent`, `acked`, `rejected`, `dropped_retry`, `restored_on_shutdown`, exposed through `EventQueue::metrics()` as bounded diagnostics (no PII). No per-query churn is written into the one durable policy bundle. A process restart resets the queue and its identifiers; there is no spool and no ordered-delivery guarantee across restarts. Without a spool the exact count of events lost before a restart is unknowable and is never reconstructed or guessed. `EventWorker::metrics()` is a production-facing status surface (used by the CLI's final status line and periodic `tracing` status logs); it reports this process's counters only and marks `prior_run_losses_unknown = true`. Do not present these figures as coverage, enforcement or a durable audit log.

`event_id` is generated at query time; `batch_id` at batch creation. Both stay stable across retries of the same batch, so an exact replay is deduplicated by the server's `(household_id, event_id)` unique key and receipts. A successful ack removes exactly the drained batch; a permanent rejection or exhausted retry is counted and dropped, never silently retried forever. Cancellation restores all unacknowledged batches to the front of the queue in FIFO order and joins the task. Concurrent queue overflow remains counted. Event counters (`emitted`, `sent`, `acked`, `lost_queue`, `invalid`) count observations; `rejected`, `dropped_retry` and `restored_on_shutdown` count batches. An allowed policy decision can still end in an upstream SERVFAIL; `allow` is the policy decision, not proof of a successful DNS answer.

## Capability contract / gaps

- **Capable:** opt-in, privacy-minimal worker observation of UDP/TCP DNS decisions; bounded, deduplicated, replay-safe HTTP delivery; honest stats counts for received observations.
- **Not capable / not claimed:** durable event spool, proxy/agent observations, verified-person attribution, enforcement/canary/coverage signal, upstream identity, resolver cache hit/miss, policy management or UI.
- **Accepted additive gate:** migration `0084` replaces `network_dns_events_cache_bounded` to admit `unknown`; the server DTO allowlist and the shared wire fixture (`tests/network-contracts/dns-events/report.json`) were extended with matching tests. `0081` was never rewritten.
- **CLI seam (implemented):** `--dns-events <FILE>` is additive and default-off. The binary loads `EventOptions`, builds `EventClient` + `EventQueue`, threads the queue into the real `serve` via `start_with_events` (in-memory) or `start_durable_with_events` (durable, canonical `Arc`), starts `EventWorker` and awaits `shutdown()` before `stop_shared()`. No credential is accepted on the command line.

## Verification

`cargo test -p family-dns --offline events::` covers queue bounds/loss, reinstatement/order, final-decision validation, strict wire DTOs, options validation and batch bounds. The real E2E test `server/src/network/dns_events_worker_e2e_tests.rs` runs the actual router over verified loopback TLS against a fresh migrated throwaway PostgreSQL, issues an explicit scoped credential, queries the real UDP/TCP listener (deny, allow, alias, cache path, unmapped source), and reads events/stats back over HTTP. It also covers outage (one retry then counted drop), auth denial, queue overflow, replay dedupe and clean shutdown.

Parent validation after the cancellation fix: nine event unit tests (including multi-batch cancellation for HTTP and transport retry), the real-binary event process test, and strict scoped clippy for DNS/server all pass. Cancellation restores all pending batches in FIFO order; oversized responses are terminal. Rust validation is serialized with the shared flock.
