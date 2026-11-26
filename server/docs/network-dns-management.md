# Stage A — bounded HTTP DNS management control plane

Status: **control plane accepted in local source, worker consumer PENDING (Stage B)**.
Migration `0079` is additive and latest; migrations `0073`–`0078` and their
checksums are untouched. This slice saves a *desired* management config and
records *worker-reported* observations. It never publishes a policy revision,
changes `original_published_at`, changes a desired-policy assignment, or claims
that a gateway applied, enforced or verified anything. The DNS worker consumer
is assigned separately; dashboard settings must not be presented as active
until that worker reports them end to end.

## Routes and grants

All admin routes are under `/api` (OIDC cookie + CSRF on writes) and require an
explicit household grant; platform roles never imply network access.

| Route | Method | Grant | Body cap |
|---|---|---|---|
| `/api/network/households/{hid}/dns/management` | GET | `network_admin` | — |
| `/api/network/households/{hid}/dns/management` | PATCH | `network_admin` | 32 KiB |
| `/api/network/households/{hid}/dns/lists/{source_id}/refresh` | POST | `network_admin` | — |
| `/api/network/households/{hid}/dns/status` | GET | `network_admin` **or** `network_events` | — |
| `/worker/network/dns-management/read` | POST | Bearer `read_dns_management`, kind `dns` | 32 KiB |
| `/worker/network/dns/status` | POST | Bearer `report_dns_status`, kind `dns` | 32 KiB |

The worker routes are top-level (no cookie/CSRF). They inherit the existing
peer-IP governor (burst 20, one token per 5 seconds). The legacy heartbeat and
`read_policy` routes keep their original 4 KiB cap; the two new routes get a
separate 32 KiB cap, with the governor layered outermost over both. A cookie
alone gets 401 on worker routes; a Bearer alone gets 401 on admin routes.

## Command issuance (only additive change to accepted gateway files)

`gateway_auth::GATEWAY_COMMAND_ALLOWLIST` adds `read_dns_management` and
`report_dns_status`. `normalize_commands(None)` still returns heartbeat-only,
migration 0079 replaces only the credential CHECK constraint and performs **no
row UPDATE**: existing heartbeat / `read_policy` credentials gain nothing.
Issuance/rotation rejects unknown commands with a 400 that names the full
allowlist. Only a `kind = 'dns'` gateway can use the new routes; household,
gateway, kind, audience, command, expiry, revocation, enabled and constant-time
secret proof are all rechecked from the locked credential row by the tiny
shared helper `gateway_service::authorize_worker_on_conn` (existing heartbeat
and policy auth paths were not refactored).

## Desired config shape (server-owned canonical bytes)

```
ManagementConfig {
  sources: [{
    id: [A-Za-z0-9_-]{1,64},
    url: https-only syntax, no userinfo/query/fragment/control chars,
         public literal host or hostname, max 512 chars,
         no github.com viewer; raw.githubusercontent.com needs /owner/repo/ref/path,
    format: "hosts" | "abp",
    enabled: bool,
    interval_secs: u64|null (300..=604800),
    max_stale_secs: u64|null (3600..=604800),
    metadata: { title, publisher, license }   // all non-blank, <=256 chars
  }],
  catalog: null | {
    version: non-blank <=200 chars,
    services: [{
      id, label, version (non-blank, <=200),
      domains: [{ type: "exact"|"suffix", value: valid domain }] (1..=512),
      source?, evidence?, license?  // optional, <=200, operator declarations
    }] (<=64)
  },
  selected_services: [service ids]  // must exist in catalog; sorted, deduped
}
```

Limits: 32 sources; canonical bytes <= 16 KiB after sorting. `catalog: null`
with no selected services is honest; selected services without a catalog are
rejected. The redacted server never resolves or fetches a URL: SSRF policy
(`no_proxy`, vetted resolver, redirects disabled, verified TLS) remains a
worker concern. Publisher/license/source are **operator declarations**, never
a compliance claim or a fabricated curated catalogue. Local bind address,
upstreams, trusted CA, cache path and local-file sources are deliberately
absent from the DTO and stay with the worker's local configuration.

PATCH operations (strict `deny_unknown_fields`, tagged by `op`):
`add_list{source}`, `remove_list{id}`, `set_list{id,patch}`,
`set_catalog{catalog}`, `select_services{ids}`. `set_list.patch` is tri-state
via the accepted nullable adapter: omitted = keep, JSON `null` = clear, value
= set (regression-tested). An identical re-add or an otherwise unchanged batch
returns `changed:false` with no version bump and no audit row.

`expected_config_version` is the only concurrency token: 0 creates version 1;
otherwise it must match the stored version exactly (CAS under the household
lock with an exact admin recheck). Stale writes get 409. Callers cannot set a
version, timestamp, digest or household id (unknown fields → 400). Audit detail
carries only operation names, version and digest — never a URL or metadata.

`GET` returns `{desired: null | {config_version, schema_version, body_sha256,
config, created_at, updated_at, updated_by}, delivery: [...], supported:
{...}}`. An empty household is `desired:null` with 200. `supported` reports
`worker_consumer:"pending"`, `service_blocking:"dns_domains"`, and `false` for
SafeSearch, statistics, serve-stale, cache-TTL controls, rate limiting,
retention controls and `verified`. No caller can set a value that implies a
missing runtime feature.

## Manual refresh (per gateway, bounded and replay-safe)

One pending token per `(household, source_id)`: monotonically increasing
`refresh_seq`, bound to the `config_version` at request time, 60 s cooldown
(repeat returns the same stored token version and expiry with `created:false`),
10 min expiry and a hard cap of 32 requests per household (corrected by migration
0080 without changing 0079). A new sequence clears the previous gateway delivery
and ack receipts before delivery of the new token. Unknown source → 404,
disabled source → 409. Config mutation deletes tokens for removed/disabled
sources and their delivery/ack rows by cascade.
Worker reads expose refreshes only for the current config version. A token from
before a config edit retains its original identity during cooldown but is not
rebound to the new config or delivered with invented historical evidence.

A token is only visible to a gateway inside its scoped manager read, which
records per-gateway delivery. Acks are keyed `(household, gateway, source_id)`
and must match the exact delivered `(refresh_seq, config_version)`: an exact
replay is idempotent; a different, future, foreign or never-delivered token is
409. Acknowledging gateway A never hides the token from gateway B.

## Delivery evidence, status and lagging applied versions

`network_dns_delivery` is a **bounded ledger of version + digest only** (no
config bytes), newest 16 per gateway plus fixed pins: the current delivered
version, the latest status's delivered version, the latest reported-applied
version and every version with an
outstanding refresh delivery. Cleanup runs on each read/status ingest. There is
no recursive provenance pin. A report's top-level `config_version` and digest
must match a delivered ledger row; `applied.config_version` may lag but must
also exist in that ledger, and the applied digest is derived from the ledger,
never from the report body. If evidence was pruned, the server returns 409
"reread management config" instead of fabricating an applied state.

`network_dns_status` keeps **one latest row per gateway** (upsert, not an
append-only history), keyed by report UUID for idempotent replay. It stores
bounded source arrays (<=32) and bounded sanitized error text — no URLs, raw
ETags or secret material. `reported_at` and `received_at` are separate from
source timestamps. The report itself must be recent (five minutes, with 60 s
future skew). Historical content/check/apply timestamps retain their original
age, from Unix epoch through now + 60 s; they are not freshened on restart.
Scheduling timestamps allow seven days + 60 s into the future to match accepted
interval/backoff limits. Far-future or pre-epoch values are rejected. No
`verified`/`enforced` field exists. The `network_events` grant can read source
ids and states only, never config metadata or URLs.

### Exact worker-side field mapping for Stage B

| Worker source | Server status field | Rule |
|---|---|---|
| `SubscriptionStatus::as_str()` / `"quarantined"` | `download` enum | one of `never_fetched`, `fresh`, `stale`, `disabled`, `failed_with_last_good`, `unavailable`, `quarantined` |
| `SubscriptionReport.checked_at` | `checked_at` | bounded timestamp |
| `SubscriptionReport.fetched_at` | `fetched_at` | bounded timestamp |
| `SubscriptionReport.content_updated_at` | `content_changed_at` | bounded timestamp |
| `SubscriptionReport.next_due_at` | `next_due_at` | bounded timestamp |
| `SubscriptionReport.cooldown_until` | `cooldown_until` | bounded timestamp |
| `SubscriptionReport.stale` | `stale` | bool |
| `SubscriptionReport.failure_count` | `failure_count` | u64 |
| `SubscriptionReport.last_error` | `last_error` | redact URLs/secrets, trim, <=200 printable chars |
| `SubscriptionReport.bytes` | `bytes` | <=8 MiB |
| `SubscriptionReport.rule_count` | `rule_count` | optional u64 |
| SHA-256 of the cached bytes | `downloaded_sha256` | 64 lowercase hex; **never** the raw ETag/`content_version` |
| `AppliedStatus.config_version` | `applied.config_version` | may lag; ledger-validated |
| `AppliedStatus.generation/filter_generation/filter_identity/applied_at/last_error` | same names | bounded; identity <=64 |
| — | `applied` **null** | truthful when delivered but never applied (failed download/compile) |

Worker status envelope: `{audience, command, household_id, gateway_id, kind,
report_id, config_version, body_sha256, reported_at, applied: object|null,
sources: [...], refresh_ack: [...]}`. Response: `{ok:true, report_id}`.
Worker read envelope: `{household_id, gateway_id, kind:"dns", config_version,
schema_version, body_sha256, config, pending_refreshes:[{source_id,
refresh_seq, config_version, expires_at}], server_time}`; `config_version:0`
with null `schema_version`/`body_sha256`/`config` means no desired config.

## Canonical digest golden fixture (pin for the worker's typed mirror)

Sources, catalog services and selected ids are sorted by id and selected ids
deduped, then `serde_json::to_vec` — no other canonical crypto or parser. The
following input (deliberately unsorted, with explicit nulls) must produce the
exact SHA below; the worker should mirror this test verbatim:

```json
{"sources":[{"id":"a_list","url":"https://raw.githubusercontent.com/o/r/main/hosts.txt","format":"hosts","enabled":true,"interval_secs":3600,"max_stale_secs":null,"metadata":{"title":"List","publisher":"Publisher","license":"MIT"}},{"id":"z_list","url":"https://raw.githubusercontent.com/o/r/main/hosts.txt","format":"abp","enabled":true,"interval_secs":null,"max_stale_secs":null,"metadata":{"title":"List","publisher":"Publisher","license":"MIT"}}],"catalog":{"version":"operator-2026-11","services":[{"id":"a_service","label":"Service","version":"1","domains":[{"type":"suffix","value":"example.test"}],"source":null,"evidence":null,"license":"operator-declared"},{"id":"z_service","label":"Service","version":"1","domains":[{"type":"suffix","value":"example.test"}],"source":null,"evidence":null,"license":"operator-declared"}]},"selected_services":["a_service","z_service"]}
```

SHA-256: `820a75626ccf71e9a30529b381dc7dd2dd5abc9209446c850b129acc2a2ea93e`.

## Verification performed

`SQLX_OFFLINE=true DATABASE_URL=<throwaway PG> cargo test -p vantyr-server
--locked --offline dns_management`: **17 passed, 0 failed**. Real HTTP over a
real router and fresh migrated databases, covering initial null GET, CAS create
and no-op, safe audits, URL/bounds/catalog rejection, policy and desired-policy
non-interference, grant/CSRF/auth separation, explicit command scopes (old and
read_policy-only credentials refused; proxy kind, tenant mismatch, disable all
401), two-gateway refresh isolation with per-gateway ack/replay/cooldown,
delivery ledger bounds and pins with honest 409 for pruned evidence, lagging
applied versions, never-applied null reports, tri-state set/clear, and untrusted
status field/timestamp/size rejection. No full-workspace suite was run (the DNS
worker crate has unrelated in-flight work).

## Real-server / real-worker validation note (Stage A + Stage B)

`server/src/network/dns_management_e2e_tests.rs` adds one bounded `#[sqlx::test]`
that runs the server and worker together, on a fresh migrated database in a
dedicated throwaway PostgreSQL only (`vantyr-netinv-test-8bdde55a`,
`127.0.0.1:58743`); no household database, no live provider and no real
credential is read or printed. Final run basis: worker/family-dns fix
`4fcac75506760d5cbff27a3e857a682cb8bccbaa`; harness commits `e6db26b0`,
`a1b7b3e5` and `561d8248` (test file + cfg(test) wiring + six test-only
dependency edges). The throwaway database password is read from the local
Docker container environment and is never echoed. Exact command used:

```sh
SQLX_OFFLINE=true \
DATABASE_URL="postgres://<throwaway-user>:<throwaway-pw>@127.0.0.1:58743/vantyr" \
  cargo test -p vantyr-server --locked --offline \
  network::dns_management_e2e_tests::real_server_and_worker_dns_management_flow \
  -- --exact --nocapture
```

**Result on that basis:** `1 passed; 0 failed; 421 filtered out` in ~34.8 s.
Compile gate `SQLX_OFFLINE=true cargo test -p vantyr-server --locked --offline
--no-run` passed; `rustfmt --check` and `SQLX_OFFLINE=true cargo clippy -p
vantyr-server --all-targets --locked --offline -- -D warnings` passed. No full
420-test workspace suite was run; the worker crate's own suite was run by its
owner, not by this harness.

It serves the actual `network::routes()` + `network::worker_routes()` behind the
real session/CSRF middleware and verified TLS with a unique per-run CA, bootstraps
a household, issues an explicit `read_dns_management`/`report_dns_status`
credential, and writes the options, credential and CA as owner-0600 files. The
worker side is the real `ManagementOptions`/`ManagementClient`/`ManagementWorker`
and the production subscription `Fetcher` and compiler; the factory reuses the
worker's exported `single_source_config` helper and the runtime-supplied cache
root. At least one phase is driven by the background coordinator loop (not only
`sync_once`). The test checks real UDP **and** TCP answers (allowed then
blocked), the server's status view (delivered/reported version, applied digest,
generation, downloaded list digest, honest original `applied_at`) and the
server-side refresh-ack row. A manual refresh carries the server-owned
`expires_at`; a changed list fixture advances the DNS answer and receipt without
changing policy revision or publish time. A runtime-free restart from the single
bundle preserves applied version, digest, bytes and original age; the subsequent
runtime restart must rehydrate the managed fetcher and report the same
downloaded hash, `fetched_at`, content-change time, byte count, rule count and
download state as before the restart (no quarantine, no stale flag). A
post-restart manual refresh is checked both with the fetch impossible (HTTP 503
from the local list origin, no server ack and no new receipt) and after a real
fetch (new origin bytes, changed UDP **and** TCP answer, valid server ack only
then). The cache directory is deliberately left intact across the runtime
restart so cache loss cannot be hidden by bundle-only DNS answers.

**Precise limitation.** Production's public-host fetcher resolver rejects
loopback, so only the subscription fetcher's DNS resolver is injected with a
loopback resolver, together with the unique private test CA for verification.
TLS still verifies against that CA; the worker's management client keeps its
unchanged verified/no-proxy/no-redirect transport. There is no insecure
verifier, no production SSRF bypass, no live provider, no mocked wire DTO and no
copied auth/serializer logic. A passing run establishes observation and
application of downloaded list bytes; it does **not** claim a canary,
enforcement or a `verified` dashboard badge, nor independent review of the
worker fix.

## Stage B gaps (not claimed here)

- The worker consumer exists, but restart-refresh and bounded source reporting
  remain integration gates. Dashboard handoff waits for their acceptance and a
  passing real-server/worker test. Dashboard clients use the session-authenticated
  admin APIs; the read/report commands are scoped worker Bearer APIs.
- No dashboard "applied/protected" badge; `verified` stays false/absent until a
  real canary and coverage check exist.
- No frontend handoff until server + worker are reviewed and an end-to-end flow
  is demonstrated.
