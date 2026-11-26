# family-dns (`vantyr-dns`)

A policy-connected filtering resolver built on the pinned Hickory 0.26.4 wire
machinery. There is no hand-written DNS parser. By default the worker is fully
in-memory; durable state is **opt-in**.

## Modes

| Mode | Flags | Behaviour |
|---|---|---|
| In-memory (default) | `--config <FILE>` | Validate, bind one high loopback UDP+TCP port, serve. Restart reads the config again. No files are written. |
| Durable | `--config <FILE> --state <FILE> --worker <ID>` | On first run only, bootstrap from the config into one atomic state file. On restart the file is authoritative and the config is used only to confirm the household identity and for explicit reloads. |
| Durable restart | `--state <FILE> --worker <ID> [--config <FILE>]` | Load the bundle and serve. A missing config file is fine while a state file exists. |

`--check-config <FILE>` validates without binding. On Unix,
`--state-status --state <FILE> --worker <ID>` prints local bundle metadata
(schema, household, worker, revision, published/saved times) and never binds.

## The one durable bundle

The state file holds exactly one JSON document: a `TypedSnapshot<Bundle>` with
`schema`, immutable `household_id` and `worker_id`, a monotonic `highwater`,
`saved_at`, and a `Bundle`. The bundle contains the complete DNS `Config`
(bind, upstreams, local zones, deny mode, profiles, devices) and the `Policy`
derived from it, including the **original** `policy.published_at`.

There is no second policy file and no independent config file that could
disagree with it. An optional top-level `policy_published_at` in the config
sets the publication time at bootstrap or reload; when omitted, the caller's
clock (`Utc::now()` in the CLI) is used and the value is persisted. A restart
never refreshes it, so an aged policy keeps failing closed for new allows.

File rules, unchanged from the shared runtime: mode `0600`, `O_NOFOLLOW` on
Unix, same-directory temp file, full write and sync, atomic rename, trusted
parent directory, single process. Durability is for a **process restart**;
the parent-directory sync after the rename is best effort and power-loss
survival is not claimed. The file is local durability only — not controller
authentication or proof of a canary.

## Reload

`DnsServer::reload(candidate_bytes, now)` and Unix `SIGHUP` (which re-reads
`--config`, bounded to 64 KiB) both take the same path:

1. Parse and fully validate the candidate config.
2. Reject a changed bind address/port/loopback opt-in (**restart required**),
   a different household, or a revision that is not strictly greater than the
   applied high-water mark.
3. Build the complete catalog, policy and denial mode **off the request path**.
4. Persist the bundle first; a failed write leaves disk and runtime untouched.
5. Swap one `Arc<RuntimeSnapshot>` under a brief `RwLock`. Queries clone that
   `Arc` before any I/O, so policy, config, catalog (including CNAME checks)
   and denial mode always come from the same version, and no lock is held
   across an `.await` or an upstream lookup.

Any validation, build or persistence failure leaves the old version serving.
Rollback is a new, higher revision carrying earlier content; a lower or equal
revision is rejected. Startup with a malformed, foreign, wrong-worker or
otherwise corrupt state file fails closed **before a listener is bound** — it
never silently falls back to the config or invents a fresh policy.

## Controller policy pull (opt-in, read-only)

An **explicit** `--controller <FILE>` turns on one HTTPS policy read from the
operator-configured controller origin. Enrollment alone never configures a
worker. The pull is `POST /worker/network/policy/read` with a JSON body
`{"audience":"vantyr-gateway-worker","command":"read_policy","household_id":…,
"gateway_id":…,"kind":"dns"}` and a scoped `Authorization: Bearer <id>.<secret>`
header. The source is the accepted server DTO in
`server/src/network/policy_dto.rs` (`PolicyReadResponse`), reused as a typed
struct here — there is no second policy model.

- `--config <FILE> --state <FILE> --worker <ID> --controller <FILE>` performs
  one pull at startup, then serves. Add `--poll` for a bounded polling loop.
  `--controller` requires durable mode **and** `--config` (the local config
  supplies bind, upstreams, local zones, deny mode and the source-IP device
  map). `--poll` requires `--controller`. No flag accepts a raw secret.
- The options file and credential file must be owner-private (Unix mode 0600;
  no group/other bits). The credential file holds one line,
  `Bearer <uuid>.<43-char secret>`. Secrets live in `secrecy::SecretString`,
  are never `Debug`/`Display`-printable, and never appear in errors or logs.
- Options file (all seconds/bounds optional; defaults shown):

  ```json
  {
    "controller_origin": "https://127.0.0.1:8443",
    "ca_pem_path": "/etc/vantyr/controller-ca.pem",
    "credential_file": "/etc/vantyr/dns-read.credential",
    "household_id": "11111111-2222-3333-4444-555555555555",
    "gateway_id": "22222222-3333-4444-5555-666666666666",
    "poll_interval_secs": 60,
    "backoff_secs": 5,
    "max_backoff_secs": 300,
    "request_timeout_secs": 10,
    "max_response_bytes": 262144
  }
  ```

- `controller_origin` must be `https` with no path/userinfo/query/fragment.
  An explicit `ca_pem_path` adds a local CA to the trust store; chain and
  hostname verification stay on, redirects are disabled so the bearer cannot
  be replayed to another origin. Plain HTTP is never accepted by the binary.
  Intervals, timeout and response size are bounded; one pull is in flight at a
  time, failures back off exponentially, and `Ctrl-C`/SIGINT cancels and joins
  the poll task before shutdown.
- `library::sync_once(server, client, now)` is the library entry point; there
  is no caller-supplied config basis. It verifies schema, gateway, household,
  outer/inner revision, original publication time and the SHA-256 digest of
  canonical serde policy bytes **before** compiling or writing anything. That
  digest is content integrity, not a signature; authentication is TLS plus the
  scoped bearer. 401/403 (expiry, revocation, missing scope) and 404 are
  decided by the controller.
- Every update (local `reload`/SIGHUP and controller pull) takes one
  updates-only mutex and compiles from the **current** active snapshot. Queries
  only clone an `Arc` from the snapshot lock and never take the update mutex,
  so no lock is held across DNS or network I/O. A local reload that happened
  first is therefore the controller compile basis; a controller pull that
  happened first raises the high-water mark so a stale local reload cannot
  overwrite it. Neither path can restore startup zones, source-IP devices,
  deny mode, upstreams or profiles over a newer local mutation.
- The core `Policy` is compiled into the same durable bundle: baseline,
  exact/suffix/`any` matchers, rule ids, reasons, schedules, timezone,
  staleness and event retention are preserved **exactly** (`config.policy_at`
  must reproduce the whole policy), while transport, local zones, upstreams,
  deny mode and weak-IP device maps come from the local config. Person rules,
  exceptions, category rules, a non-deny default, or a profile referenced by
  a device but absent from the controller candidate are `Unsupported` — the
  old bundle keeps serving. Same revision + same whole policy is an idempotent
  no-op (no save-time or policy-age reset); same revision + different content
  is rejected; a newer policy goes through the same persist-then-swap path as
  SIGHUP with a monotonic high-water mark.
- Capability results are only `Unsupported`, `Unchanged` and `AppliedLocally`.
  `available()` means the local pull path works. There is **no** controller
  acknowledgement, applied receipt, canary or verified/enforced claim.

## Local list and selected-service filtering

An optional top-level `filter` object adds bounded **settings** to the 64 KiB
config; the validated list **bytes** never live in that config:

```json
"filter": {
  "sources": [
    { "id": "hosts-local", "format": "hosts", "path": "/etc/vantyr/hosts.txt" },
    { "id": "ads-local", "format": "abp", "path": "/etc/vantyr/ads.txt",
      "source_url": "operator attribution (metadata only, never fetched)" }
  ],
  "catalog": { "version": "v1", "services": [
    { "id": "video", "label": "Video", "version": "1", "evidence": "operator selection",
      "domains": [{"type":"exact","value":"video.example"},
                  {"type":"suffix","value":"social.example"}] }
  ]},
  "selected_services": ["video"]
}
```

- `hosts` sources use Hickory's maintained blocklist parser (bare domains,
  address prefixes, leading wildcards, IDNA canonicalisation); `abp` sources
  use the maintained adblock engine for `||host^`, `@@||host^`, `$important`.
  Regex, paths, cosmetic rules and context modifiers are rejected with
  diagnostics. A future subscription layer can hand validated bytes to the
  same compiler; this worker never fetches a URL.
- Only `enabled: true` sources are read. Setting `enabled: false` or removing a
  source removes its rules on the next reload; only service ids listed in
  `selected_services` can block. The catalog is operator-supplied domain sets,
  not an exhaustive feed or an app-identity claim.
- Bootstrap/reload reads each configured source as a bounded, regular,
  non-symlink file **before** binding or publishing, then compiles the
  immutable `FilterSnapshot` and persists its bytes plus derivation metadata
  (per-list SHA-256, accepted/rejected counts, selected services, totals) in
  the **one** bundle. Source paths are never re-read: an abrupt restart after
  a source file changed or vanished still serves the filter that was actually
  applied, with the original policy age.
- The one bundle store is explicitly raised to a 16 MiB serialization ceiling
  so the accepted 8 MiB raw aggregate fits after base64 + JSON overhead. The
  runtime default remains 1 MiB for every other store and all prior payloads;
  old bundles without `filter` stay valid.
- Household policy is authoritative. A query is checked against lists only
  after policy allowed it, so an `@@` `AllowException` is *list-layer only* and
  can never override a baseline, stale/core or household deny. Blocks apply to
  the initial question and to supported CNAME/differing-owner A/AAAA alias
  targets; only A/AAAA/CNAME are evaluated.
- Observations carry source id, list/service kind and an upstream rule only
  when the backend exposes one. Hickory lookups expose no matched entry, so no
  per-line hosts evidence is fabricated. `source_url` is attribution metadata
  and never appears in per-query observations or URL history.
- `DnsServer::apply_filter_material(revision, material, now)` is the small
  typed seam for a future fetch layer: validated material goes through the
  same compile -> persist -> publish path with no second filter store and no
  swallowed errors. Controller pulls preserve the current settings and
  material under the updates mutex, so a local filter change cannot be
  reverted to the startup filter by a later pull.

## Verified encrypted upstreams (DoT / DoH)

A small `encrypted_upstreams` config array sits beside the existing literal
UDP/TCP `upstreams`. Each entry declares `scheme` (`dot` or `doh`), an IP-literal
`bootstrap`, optional `port` (default 853 / 443), the certificate `server_name`,
an optional bounded `ca_pem`, and for DoH an explicit `path`. Mixing plaintext
and encrypted upstreams is rejected; an encrypted route never adds a plaintext
or system resolver, never uses opportunistic encryption, and has no fallback.
The bootstrap is a literal address so the verification hostname is never
resolved a second time; for DoT the name is used for verification (SNI is
disabled upstream), for DoH it is also the TLS SNI with HTTP/2 ALPN.

Trust is WebPKI roots plus the operator's explicit CA material, verified by
maintained rustls/Hickory code. All configured `ca_pem` values are pooled across
all encrypted upstreams; a CA added on one entry is trusted for every entry's
verification hostname. This is shared operator trust, not per-endpoint CA
isolation. No certificate-verification bypass or
plain/system fallback flag exists. All upstreams share one 8-entry cap; invalid
URLs, hostnames, zero ports, self-loops (including mapped IPs), malformed CA
material and oversized values are rejected before any listener binds. The
settings live in the one durable bundle, are preserved by controller pulls and
local reloads, and are recompiled unchanged after restart. Per-domain routing,
fallback, DoQ/H3 and DNSCrypt are not part of this slice.

## Optional DNS management consumer

`--dns-management <FILE>` is OFF by default and requires durable mode. The
private options file uses the same owner-private origin/credential/CA pattern
as the controller pull; no secret is accepted on the command line. One bounded
cancellable task reads desired list/service settings over verified HTTPS,
compiles them with the current local settings, and reports a worker
observation back. It never opens a listener, claims enforcement or canary
status, or fetches a URL the operator did not configure.

Applied management version/digest, validated config and bounded refresh
receipts live in the one durable bundle. Management version and digest are
independent of policy revision/publication, the bundle generation and the
filter generation: a management commit advances only the bundle generation
(and the filter generation when material identity changes). Identical desired
configs make no write; receipt commits are bounded. Remote settings cannot
change local bind paths, cache paths, CA/trust, upstreams, device mapping,
local file lists or the household baseline; local/remote id collisions and
aggregate bound violations are rejected. Missing or invalid downloads,
authentication, digest/schema/version errors leave the applied answer, disk
and original policy age untouched. Status reports download state and applied
digest/generation separately, with redacted bounded errors.

### Cross-server contract verification

The worker tests use a local HTTPS mock of the accepted wire DTOs. A full
cross-server run uses the server crate's real router and migrated test database
with `SQLX_OFFLINE=true DATABASE_URL=<throwaway PG> cargo test -p vantyr-server
--locked --offline dns_management`. To exercise the worker against it: issue a
scoped `read_dns_management`/`report_dns_status` credential for one gateway,
write the worker options file (origin, owner-private credential and CA), patch
a desired list config through the admin API, then launch
`vantyr-dns --config <cfg> --state <state> --worker <id> --dns-management
<options> --subscriptions <settings>` with a reachable HTTPS list URL. Verify
the answer on UDP/TCP, read the server's status view for the reported applied
version/digest and refresh receipts, restart the worker offline from its bundle
and confirm the original age is preserved. No live public provider is needed;
use a test HTTPS endpoint and the vetted production fetch path.

## Independent counters and scheduled subscriptions

The one durable bundle carries three independent counter spaces:

- `policy.revision` / `policy.published_at` — the household/controller policy
  space. **List refreshes never touch either value.**
- `bundle_generation` — advances on every durable commit (policy change,
  local reload or list refresh). It is the store's monotonic high-water mark.
- `filter_generation` — advances only when the applied list material content
  actually changes. Identical re-downloads are idempotent: no new generation,
  no disk write.

`--state-status` prints all three separately. A schema-1 bundle written before
these counters existed is migrated explicitly on load from its old high-water
mark; impossible, partial or inconsistent counters are rejected before a
listener exists. No timestamp or policy content is freshened by migration, and
a generation overflow is an explicit error rather than a wrap.

An **explicit** `--subscriptions <FILE>` (durable mode required) enables a
single cancellable integrator loop that reuses the accepted
`vantyr-network-subscriptions` fetchers. The small settings file holds source
ids, HTTPS URLs, formats, enablement, intervals, required operator metadata, a
cache directory and an optional trusted CA — never bytes. Each candidate is
compiled with the maintained parser for its configured format before the cache
promotes it. The integrator then assembles ALL current enabled sources plus
the local service catalog, compiles within the 8 MiB aggregate bound and uses
the same material path as a local reload. No URL is fetched without that opt-in
and no provider is bundled.

A clean installation has no applied bundle and no cache: startup performs ONE
bounded verified fetch/compile before binding, and fails closed if required
material is still missing. A valid bundle restart never fetches or revalidates
a cache before serving — a missing, corrupt or URL-mismatched cache is
quarantined per source with a bounded diagnostic and a bounded retry, while
the applied bytes and original publication age are served immediately.

The canonical `Arc<DnsServer>` returned by `start_durable_with_subscriptions`
must be kept for the runtime lifetime; `stop_shared()` cancels and awaits the
integrator task before consuming the listener. Manual refresh requests touch
only the named source; cooldowns and configured intervals remain in force.
Material candidates carry the bundle generation observed at preparation time;
a concurrent reload/controller commit invalidates that basis and the integrator
rebuilds from current settings within a bounded retry count.

Download state is not enforcement state: `DnsServer::subscription_status()`
reports per-source download status/checked time/error alongside what DNS
actually applied (generation, filter identity, applied time, last combined
error). A failed download, bad syntax, empty/oversized candidate, redirect,
429/503, TLS failure or failed persist leaves the whole last-known-good filter
and disk untouched and reports the error. An enabled source with no cache on
first boot fails closed — there is no empty-list fallback. On restart the
bundle is authoritative even if the cache or config changed while down.

## Scope and limits (honest)

- Local-disk state is unauthenticated local durability. No gateway credential,
  controller ack, canary or "verified/protected" UI claim is implemented here.
- There is no HTTP control API in the worker; local control is the library
  `reload` method and SIGHUP only. The only outbound route is the read-only
  controller pull above. Host resolver, router, DHCP and firewall settings are
  never changed.
- Bounded runtime events exist in `vantyr-network-runtime` but are **not**
  wired into this worker in this slice; decision observations are a small
  in-process ring, not a durable event store.
- Scheduled downloads are opt-in and use only public HTTPS URLs the operator
  configured; there is no HTTP management API, UI badge or "safe" claim, and
  no host resolver/DHCP/firewall/CA-trust change. ABP Unicode/IDN rules are
  rejected by the accepted upstream adapter with a diagnostic (hosts-source
  IDNA is supported); no exhaustive service catalog is shipped.
- Alias inspection covers CNAME and differing-owner A/AAAA answers only.
  SVCB/HTTPS, DNAME, other redirection mechanisms and TSIG-signed queries are
  out of scope. RD/CD are preserved on every response path; multiple A/AAAA
  records per owner are retained.
- The config reader is capped at 64 KiB; all collections and string lengths
  have hard bounds. Non-loopback binds require explicit opt-in and stay
  private.

## Tests

`cargo test -p family-dns` covers real UDP/TCP filtering, alias chains,
upstream cache/outage, mapped-IP handling, atomic reload with consistent
answers and revisions, whole-version reads under concurrent queries/reloads,
rejection of invalid/stale/foreign/bind-changing candidates, injected
persistence failure, bundle restart with unchanged publication age, stale-age
fail-closed, no-listener-on-corrupt-state, and real-process restart/SIGHUP.
`cargo test -p family-dns --test filter_runtime` adds real UDP/TCP tests for
hosts/ABP blocks and exceptions, `$important`, selected service exact/suffix
coverage, truthful evidence, alias-target blocking, explicit unsupported query
types, whole-version concurrent reload, missing/malformed/unsupported/oversized
candidate rejection, restart from persisted bytes, controller-pull material
preservation, and the typed material seam.
`cargo test -p family-dns --test subscription_dns` adds real verified-TLS
list-server tests for first-boot fail-closed, 200/304/changed-200 behaviour,
bad/outage responses, counter-space separation, offline restart, persist
failure retry, idempotent refreshes and baseline authority.
`cargo test -p family-dns --test generation_migration` covers legacy counter
migration, impossible/mixed/zero/overflow counters and on-disk material
tampering. `cargo test -p family-dns --test controller` adds real-TLS mock-controller
tests: the exact read-policy request/contract, scoped bearer custody, digest
and outer-field mismatch rejection, bad-CA/plain-HTTP rejection, 401/404
outage preservation, unsupported person/category policies, idempotent and
conflicting same-revision pulls, lost-ack restart with an unchanged stale age,
concurrent local reload versus controller pull, and a cancelled/joined poll
task. No test uses privileged ports, raw secrets in logs or host network
configuration.

Remaining gap (deliberate): the controller has no acknowledgement endpoint or
verification path yet. A locally applied policy is not reported as applied or
enforced to the controller, and no canary boolean exists. Report/verification
integration is separate follow-up work.
