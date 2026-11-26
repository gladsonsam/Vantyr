# Durable DNS events and statistics (server foundation)

Status: **server foundation accepted in local source; worker emitter integration is an explicit later gate.** Migration `0081` is additive and latest; migrations `0073`–`0080` and their checksums are untouched. This slice stores worker-reported DNS observations and serves bounded query-log/stats reads. It does **not** configure a worker, publish policy, change management revisions, claim enforcement, or verify coverage. No family-dns, proxy, runtime, filter, frontend, lab or host-network file is changed here.

## Routes and grants

| Route | Method | Grant / credential | Body cap |
| --- | --- | --- | --- |
| `/worker/network/dns/events` | POST | Bearer command `report_dns_events`, kind `dns` | 256 KiB |
| `/api/network/households/{hid}/dns/events` | GET | `network_admin` **or** `network_events` | — |
| `/api/network/households/{hid}/dns/stats` | GET | `network_admin` **or** `network_events` | — |

The worker route is top-level and cookie-free; it shares the existing peer-IP governor (burst 20, one token per 5 s) with the other worker routes. The read routes live under `/api`, inherit OIDC session cookie + CSRF; a Bearer alone gets 401 on them and a cookie alone gets 401 on the worker route. Platform roles never imply network access; a grant on another household returns 403. `network_enroll` alone never reads events.

`report_dns_events` is a **new explicit opt-in command**. `normalize_commands(None)` still returns heartbeat-only, migration `0081` replaces the command CHECK with no row UPDATE, and issuance/rotation reject unknown commands with a 400 naming the full allowlist. Existing heartbeat, `read_policy`, `read_dns_management` and `report_dns_status` credentials gain nothing. Authorization rechecks audience, command, household, gateway, kind, expiry, revocation, gateway-enabled and constant-time secret proof from the locked credential row (`authorize_worker_on_conn`).

## Attribution rules (non-negotiable)

1. A record is a **worker observation of a DNS query on a device/network path**, never a verified person action. There is no `person_id` and no `verified`/`enforced` field in the request or response. The read row always emits `person_label: null` and `evidence: "network_observation"` (weak evidence, never a verified session).
2. `device_id` is optional. When present it is accepted only if a `network_assignments` row exists for `(device_id, household_id)`; it identifies a device, not the human using it. Null/unknown stays unknown. `device_label` is a plain inventory join label, not an identity claim.
3. `observed_at` is worker-reported and bounded to `[now − 30 d, now + 60 s]`. The server records `received_at` separately. Neither is freshened on reads.
4. `name`/`domain` is a DNS query name only: validated domain shape, no URL, path, query string, fragment, userinfo, control characters or secret markers. `filter_source_id` is an opaque operator id, never a URL. `reason_code`, `applied_rule`, `upstream`, `filter_source_kind` and `correlation_id` are bounded, sanitized tokens. No body, header, credential, raw ETag or page content is stored. A database CHECK mirrors the free-text guard.
5. Counts reflect **actual received, deduplicated observations** inside the requested window only. `(household_id, event_id)` is unique, so replays cannot double-count. Statistics do not imply enforcement, canary success or coverage of off-path/DoH/QUIC traffic.
6. Supported source is **only `dns`**. `proxy` and `agent` ingestion is not implemented; reads report `sources: ["dns"]` and `unsupported_sources: ["proxy","agent"]`. A `source` filter other than `dns` is a 400, not a silent empty result. No inspection counts are invented. Grouping by host is not provided (`by_host` is deliberately absent); the domain grouping is query-name based.

## Worker batch shape (`deny_unknown_fields`)

```
EventBatchBody {
  audience: "vantyr-gateway-worker", command: "report_dns_events",
  household_id: Uuid, gateway_id: Uuid, kind: "dns",
  batch_id: Uuid,
  events: [ DnsEvent { ... } ]   // 1..=256
}
DnsEvent {
  event_id: Uuid, observed_at: RFC3339,
  device_id?: Uuid,
  name: domain (<=253, normalised lower-case, root dot stripped),
  query_type: A|AAAA|CNAME|SOA|TXT|MX|SRV|NS|PTR|CAA|SVCB|HTTPS|DNAME|DS|DNSKEY|ANY,
  protocol: udp|tcp|dot|doh|doq|dnscrypt|h3|unknown,
  allow: bool, reason_code: <=64, policy_revision?: 0..=i64::MAX,
  applied_rule?: <=200, upstream?: <=64,
  cache_state: hit|miss|stale|bypass,
  flags?: { rd?, cd?, ra?, ad? },
  filter_blocked?: bool, filter_source_id?: <=64,
  filter_source_kind?: list|service, denied_alias_target?: domain,
  correlation_id?: <=64
}
```

Validation happens before any database work: unknown fields, empty/oversized batches, duplicate `event_id` within a batch, bad domains/enums/timestamps, out-of-window times, unscoped `device_id`, wrong audience/command/kind and unauthorised credentials are refused (400/401) without writes.

**Dedup and replay.** A batch receipt is keyed `(household_id, gateway_id, batch_id)` and stores only a SHA-256 of the canonical accepted bytes plus counts. An exact replay returns the original outcome with `replayed: true` and inserts nothing new; the same `batch_id` with different bytes is a 409. Overlapping `event_id`s in a later batch are skipped (`duplicates`). Ingest runs under the `household → gateway → credential` lock; concurrent batches cannot exceed the hard caps.

## Read contracts

`GET .../dns/events` query parameters (strict, unknown fields → 400): `domain` (substring, escaped) or its alias `q`, `device_id`, `reason` (exact), `allow=true|false` or `decision=allow|deny`, `source=dns`, `from`/`to` RFC3339 inclusive (`from <= to`, bounded to 30 d age and 60 s future skew, default last 24 h), `limit` 1..=200 (default 50), `offset` 0..=100000, and `cursor` (opaque base64url keyset; mutually exclusive with `offset`).

Response fields include the frontend integration shape: `event_id`, `time`/`observed_at`, `received_at`, `source`, `device_id`, `device_label`, always-null `person_label`, `evidence`, `domain`, `effect` (`allow`/`deny`), `allow`, `reason`/`reason_code`, `policy_revision`, `correlation_id`, protocol/query/cache/upstream/rule/filter metadata and flags. Envelope: `total`, `has_more`, `next` (cursor or offset string), `next_offset`, `next_cursor`, `pagination_limited`, `truncated`, `from`/`to`, `observed_only: true`, `sources`, `unsupported_sources`, and `retention { keep_days, oldest_stored, stored_count, cap_count }`. `total` and page come from one `REPEATABLE READ` snapshot with identical predicates. `truncated` is true when the page hit the offset cap or the household count cap may have evicted earlier matches.

`GET .../dns/stats` query parameters: `window` in `1h`, `24h` (default), `7d`, `30d`; optional `device_id` (must be assigned in this household). The response exposes requested `window_start`/`window_end`, `actual_window_start`/`actual_window_end` (bounds actually covered by retained observations), `retention_days`, `oldest_stored`, `newest_stored`, `stored_count`, `cap_count`, and `shortened`. `shortened` is true when the requested window is not fully covered because it is empty, age retention removed rows, **or count-cap evictions dropped observations** — not merely because of `keep_days`. All figures (`total_queries`, `allowed`, `blocked`, `time_series`, `top_domains`, `top_blocked`, `top_devices`, `unknown_device_queries`) come from received, deduplicated rows in the same window and snapshot; empty time buckets are real zeros. Top lists are capped at 20 with explicit truncated flags. `time_series` sums to `total_queries`. `sources`/`unsupported_sources` and `observed_only: true` make the scope explicit.

## Retention

`dns_events_retention.rs` clamps environment overrides (`VANTYR_DNS_EVENT_DAYS`, `VANTYR_DNS_EVENT_MAX`, `VANTYR_DNS_EVENT_BATCH_MAX`) to hard caps (30 days, 50,000 events and 10,000 receipts per household; defaults 7 days, 5,000 and 1,000). The same clamped policy is enforced on every ingest for the writing household (age + count, inside the lock) **and** by `prune_dns_events`, which is wired into `platform::retention::prune_auxiliary_retention` — the existing startup and periodic production task — so idle households are pruned too. There is no unbounded archive and no synthetic count.

## Verification

`SQLX_OFFLINE=true DATABASE_URL=<throwaway PG> cargo test -p vantyr-server --locked --offline dns_events`: 10 passed / 0 failed against fresh migrated databases and real HTTP: credential/cookie/CSRF/grant/tenant separation, invalid batches with no writes, replay/dedup/concurrent batches, filters/pagination/cursor, stats windows/counts/series/top lists/shortening honesty, and age+count retention through the production helper. `cargo fmt --all --check` and strict scoped clippy (`-D warnings`) are clean. All new SQL uses the runtime `sqlx` API, so `server/.sqlx` is unchanged. No dependency or manifest change.

## Gaps (explicit)

- Worker emitter/producer integration is a later, explicitly authorised gate; no worker in this repository emits these batches yet.
- No proxy or agent observation ingestion, no inspected/traffic-count synthesis, no `by_host` grouping, no verified-person attribution, no canary/coverage signal, no policy management/history change and no UI work.
- Read/ingest semantics are DNS-observation-only; the 30-day maximum age is a storage bound, not a coverage promise.
