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

## Scope and limits (honest)

- Local-disk state is unauthenticated local durability. No gateway credential,
  controller ack, canary or "verified/protected" UI claim is implemented here.
- There is no HTTP control API; local control is the library `reload` method
  and SIGHUP only. Host resolver, router, DHCP and firewall settings are never
  changed.
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
No test uses privileged ports or touches the host network configuration.
