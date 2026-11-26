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
`cargo test -p family-dns --test controller` adds real-TLS mock-controller
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
