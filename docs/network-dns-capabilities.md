# First-party DNS capability catalog and acceptance gate

This document is the neutral, current-state delivery gate for the Vantyr DNS
worker and its control plane. It records behavior contracts, honest status and
the acceptance evidence required to close each row. It is not a roadmap history,
a product comparison or a deployment claim. State is read from the working tree
at commit `cd4d4029`; in-flight code is marked accordingly and does not close a
row. No deploy, release or host-network change follows from this catalog.

**Status legend.** `AcceptedRuntime` = implemented, tested and independently
accepted in local source. `PartialRuntime` = some of the contract is served, a
named part is not. `LibraryOnly` = a local library implements a subset but no
worker consumes it. `InProgress` = committed-but-unreviewed or uncommitted
working-tree work; not accepted. `Missing` = no local implementation.
`Excluded` = deliberately outside this product's scope. `NeedsPlatformDecision`
= platform/security enhancement requiring an explicit decision before work.

**Non-negotiable boundaries for every row.** No blanket TLS-verification skip
anywhere; verification failures fail closed on last-known-good. No fail-open
when trust, policy age or state is unknown: the household baseline stays deny
and new allows require verified state. No person, adult status or privilege is
inferred from an IP, a public address or a spoofed client label; device and
observation identity are weak evidence only. Router DHCP is retained by the
operator; this work never assigns addresses or edits router/firewall state.
The UI is user-owned and mobile is deferred; worker auth reuses the same OIDC
identity and scoped grants, not a separate login or endpoint family. Existing
backup, recovery and package-update flows are reused; no DNS self-updater is
required and no release is published by this catalog. Library existence is not
worker acceptance: a stage stays `PartialRuntime` until every row it gates is
`AcceptedRuntime`.

Code links point to tracked files at this commit; untracked working-tree paths
are shown as plain module paths and labelled `InProgress`. Acceptance tests are
the minimum meaningful check for each contract, not a promise that it is already
written for a `Missing` row.

## A. Listener and server transports

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| LST-01 | Plain UDP and TCP on one configured port; privileged port only by explicit operator decision | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) `BindConfig`, [server.rs](../crates/family-dns/src/server.rs) | One config serves two bind IPs (v4 + v6) on the same port; both answer |
| LST-02 | IPv4-mapped source canonicalisation and request-derived header flags on allowed, NXDOMAIN, REFUSED and sinkhole paths | `AcceptedRuntime` | [handler.rs](../crates/family-dns/src/handler.rs), [functional.rs](../crates/family-dns/tests/functional.rs) | Mapped source selects the plain-IPv4 device profile; RD/CD echoed on every path |
| LST-03 | DoT server listener with policy applied to decrypted queries | `Missing` | none in `crates/family-dns` | TLS handshake on configured port; denied query refused; bad chain rejected |
| LST-04 | DoH server with GET/POST query route and per-client path form | `Missing` | none in `crates/family-dns` | DoH POST and GET answered; per-client route uses the right profile |
| LST-05 | DoQ server listener | `Missing` | none in `crates/family-dns` | QUIC query answered with policy applied; transport failure fails closed |
| LST-06 | DNSCrypt server, including disabled state at zero port | `Missing` | none in `crates/family-dns` | DNSCrypt query answered; port zero leaves no listener |
| LST-07 | HTTP/3 transport for encrypted DNS, with and without fallback | `Missing` | none in `crates/family-dns` | H3 query answered; fallback path behaves as configured |
| LST-08 | DNS server certificate lifecycle: load, chain/hostname validation, reload without restart, own trust roots; separate from proxy PKI | `Missing` for DNS; proxy custody accepted separately | `crates/network-pki` is proxy-scoped, not a DNS TLS hook | Replace cert file, reload, new handshake succeeds; expired/wrong-host cert rejected with no bypass |
| LST-09 | Self-loop and public-bind guards reject unsafe listener/upstream combinations | `AcceptedRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs), [config.rs](../crates/family-dns/src/config.rs) | Mapped and plain self-loop rejected before a listener exists; non-loopback needs opt-in |

## B. Upstream resolution and routing

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| UP-01 | Plain UDP/TCP forwarding plus authoritative local zones, A/AAAA/CNAME and SOA | `AcceptedRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs), [handler.rs](../crates/family-dns/src/handler.rs) | Local zone, forwarded answer and negative SOA each returned through the handler |
| UP-02 | Encrypted upstream schemes (DoT, DoH, DoQ, DNSCrypt, H3) | `Missing` | [config.rs](../crates/family-dns/src/config.rs) accepts only IP:port literals | Route one query per scheme; certificate failure keeps last-known-good policy and answers fail closed |
| UP-03 | Bootstrap resolvers for hostname-named upstreams | `Missing` | no hostname upstream accepted | Hostname-only upstream resolves via bootstrap then answers |
| UP-04 | Fallback upstream when primary is unreachable | `Missing` | none in `crates/family-dns` | Kill primary; fallback answers; policy revision unchanged |
| UP-05 | Domain-selected upstream routing, more-specific override and return-to-default marker | `Missing` | local split zones only in [runtime.rs](../crates/family-dns/src/runtime.rs) | `*.internal` routes only to its upstream; broader rule overridden; default marker restores root |
| UP-06 | Timeout, concurrency and genuine health/selection modes (parallel, fastest, load-balanced) | `PartialRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs) fixed 2s timeout, 2 concurrent requests, no health weighting | Three upstreams, one failing; each mode selects correctly and recovers after health returns |
| UP-07 | Upstream test endpoint reporting OK/error per upstream including timeout | `Missing` | none | Endpoint reports per-upstream result without leaking credentials |
| UP-08 | Trusted-proxy real-client extraction for encrypted client transports | `Missing` | none | Trusted proxy maps device profile from real client IP; untrusted header ignored |
| UP-09 | Upstream self-loop rejection after ephemeral port assignment | `AcceptedRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs), [functional.rs](../crates/family-dns/tests/functional.rs) | Upstream pointing back at bound listener rejected before start |

## C. Cache, DNSSEC options and response shaping

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| CAC-01 | Positive/negative cache toggle, size and TTL min/max bounds | `PartialRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs) uses a fixed 4096-entry cache | Configure bounds; TTL 1s and very large TTL clamped; disabled cache yields no hits |
| CAC-02 | Optimistic cache serve with bounded answer TTL while refreshing | `Missing` | none | Expired entry served at configured short TTL during refresh |
| CAC-03 | Cache clear operation | `Missing` | none | Clear then re-query hits upstream, not cache |
| CAC-04 | DNSSEC request option (DO) configuration, kept separate from response header-flag preservation already accepted in LST-02 and from a validator | `Missing` | no DO configuration; AD/header flags already preserved under LST-02 | DO set on upstream query; AD/header flags asserted under LST-02; no validator claimed |
| CAC-05 | Full local DNSSEC validator | `NeedsPlatformDecision` | none | Security enhancement only: if adopted, signed chain validated and bogus refused; decision recorded before work |
| CAC-06 | EDNS Client Subnet, default off, with explicit opt-in and custom override | `Missing` | none | Default adds no ECS option; opt-in adds real subnet; custom overrides; log records ECS |
| CAC-07 | Disable IPv6 answers and strip IPv6 hints from related answers | `Missing` | [runtime.rs](../crates/family-dns/src/runtime.rs) always requests IPv4 and IPv6 | AAAA returns empty; HTTPS hints stripped |
| CAC-08 | Optional system hosts-file resolution | `Missing` | [runtime.rs](../crates/family-dns/src/runtime.rs) sets hosts lookup to never | Enabled hosts entry resolves locally; disabled does not |
| CAC-09 | Bogus-NXDOMAIN by answer IP list | `Missing` | none | Response containing configured IP becomes NXDOMAIN |
| CAC-10 | Null/custom-IP denial with configurable TTL | `AcceptedRuntime` | [config.rs](../crates/family-dns/src/config.rs) `DenyConfig::Sinkhole`, [handler.rs](../crates/family-dns/src/handler.rs) | Sinkhole to 0.0.0.0, :: or custom IP returns configured TTL; no alias-mode API is required |
| CAC-11 | Denial modes NXDOMAIN and REFUSED with validation | `AcceptedRuntime` | [config.rs](../crates/family-dns/src/config.rs), [functional.rs](../crates/family-dns/tests/functional.rs) | Both modes configurable; invalid sinkhole config rejected at startup |
| CAC-12 | Per-subnet rate limit, CIDR whitelist and ANY amplification refusal | `Missing` | [runtime.rs](../crates/family-dns/src/runtime.rs) only has a global active-request cap | Subnet QPS cap enforced; whitelist exempt; ANY refused |

## D. Filter syntax, rewrites and aliases

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| FLT-01 | Hosts-file and bare-domain lines; exact, suffix and any matchers with diagnostics | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) `MatchSpec` and its tests | Host/domain lines compile and match; unknown fields rejected |
| FLT-02 | Maintained-list notation (double-pipe host anchor, exception, regex, wildcard) compiled with honest diagnostics | `LibraryOnly` | `crates/network-filter/src/{hosts,abp}.rs` (untracked, not a worker member) | A maintained list compiles with per-rule diagnostics; regex/path rules rejected honestly, never silently matched |
| FLT-03 | Full context-modifier scope: client, ctag, denyallow, dnstype, dnsrewrite, important, badfilter | `InProgress` | `crates/network-filter/src/abp.rs` currently accepts only the importance modifier and rejects the rest | Each modifier changes one decision; an unsupported modifier yields a diagnostic, not a silent match; scope is not reduced because the first adapter rejects it |
| FLT-04 | Deny-over-allow precedence inside a profile, with safety-first tie handling | `AcceptedRuntime` | `crates/family-policy/src/eval.rs`, [functional.rs](../crates/family-dns/tests/functional.rs) | Matching deny wins over allow; no exception silently grants adult access |
| FLT-05 | Per-client and tag-scoped rule selection | `Missing` | DNS sees source IP only; [policy.rs](../crates/family-dns/src/policy.rs) has no session | Tag rule applies only to tagged device; spoofed label cannot select an adult profile |
| FLT-06 | Schedules with timezone and DST handling for profiles and rules | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) `ScheduleSpec`, `crates/family-policy/src/eval.rs` | Window enforced in local time including DST fold; service/client schedules remain ungated |
| FLT-07 | Local wildcard records and RR breadth with keep-upstream values | `PartialRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs) A/AAAA/CNAME/SOA; no wildcard or keep-upstream | Wildcard rewrite answers with an A keep-upstream value |
| FLT-08 | Rewrite suppression forms (NODATA, NXDOMAIN, REFUSED) and full RR set | `Missing` | none | TXT/SRV/HTTPS rewrite returned; each suppression form produces the right rcode |
| FLT-09 | Alias-chain denial for CNAME and differing-owner A/AAAA | `AcceptedRuntime` | [handler.rs](../crates/family-dns/src/handler.rs) | Allowed alias resolving to a denied target becomes the configured denial with evidence |
| FLT-10 | Alias breadth for SVCB, HTTPS, DNAME and TSIG-signed queries | `Missing` | excluded in [handler.rs](../crates/family-dns/src/handler.rs) header comment | Aliased blocked domain via these forms is denied or the limit is formally accepted |
| FLT-11 | Built-in rebinding protection | `NeedsPlatformDecision` | none | Security enhancement only; explicit decision needed, no parity claim |

## E. Public list subscriptions, services and SafeSearch

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| SUB-01 | Public list URL add/remove/set and explicit enable/disable | `InProgress` | `crates/network-subscriptions/src/{config,worker}.rs` (untracked) | Operator URL ingested, compiled and enforced by a worker snapshot |
| SUB-02 | Interval, manual refresh, conditional GET, last-known-good, count, dedup, freshness, status and declared source/licence | `LibraryOnly` | `crates/network-subscriptions/src/{fetcher,cache,scheduler,status}.rs` | 304 then 200; 500/malformed keeps last-known-good; status reports fresh/error/disabled truthfully |
| SUB-03 | Worker consumes fetched bytes through compile, validate and atomic swap | `InProgress` | no path from subscription library to DNS snapshot | A refreshed list changes answers; a failed refresh leaves answers unchanged |
| SUB-04 | Diagnostics and test-host lookup returning reason, rule text and service attributes | `Missing` | in-process decision view only | Endpoint reports why blocked with matched rule text; URL history never stored |
| SUB-05 | Curated service catalog with declared source/provider, selected IDs only, domain coverage that is partial and not app identity | `InProgress` | `crates/network-filter/src/service.rs` uses synthetic fixtures | Named service blocks its domains, unknown ID rejected, provenance/licence recorded truthfully |
| SUB-06 | SafeSearch per engine, including YouTube restricted mode, using real declared providers | `Missing` | none | Search/image/video engine domains rewritten per client; YouTube restricted mode enforced; no fabricated provider |
| SUB-07 | Parental and malicious-domain feeds with real provider, licence and recovery behaviour | `Missing` | none | Feed domain blocked with correct reason; provider unavailable keeps last-known-good |

## F. Clients, protection and observability

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| CLI-01 | Exact-IP device mapping including IPv4-mapped sources | `AcceptedRuntime` | [config.rs](../crates/family-dns/src/config.rs), [functional.rs](../crates/family-dns/tests/functional.rs) | Mapped and plain source select the same device profile |
| CLI-02 | Client identity breadth: CIDR ranges, observed MAC, observed client ID, weak labels | `Missing` | [config.rs](../crates/family-dns/src/config.rs) stores exact source IPs | CIDR selects profile; observed MAC selects only when actually observed; no public-IP person inference |
| CLI-03 | Per-client tags, upstreams, log-ignore, stats-ignore and cache controls | `Missing` | none | Tagged client uses its upstreams and is omitted from log/stats when configured |
| CLI-04 | Spoofed client ID cannot promote a device to adult profile; person rules need verified state | `AcceptedRuntime` | [compile.rs](../crates/family-dns/src/compile.rs), [policy.rs](../crates/family-dns/src/policy.rs) | Client-ID-shaped header cannot grant; unverified person rule rejected, unknown source stays restricted |
| CLI-05 | Global and per-device protection pause with expiring scoped exception | `Missing` | always enforcing; stale policy fails closed | Pause expires and enforcement resumes; baseline deny cannot be silently disabled |
| CLI-06 | Explicit allow/deny client lists and blocked-host handling | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) only has restrictive unknown default | Explicit allow/deny lists applied; blocked hosts answered or dropped as configured |
| CLI-07 | BYOD enrollment using existing OIDC identity and scoped grants | `InProgress` | `server/src/network/enroll_*`, migration `0078` (uncommitted) | Single-use grant binds device, asserted person, expiry and purpose; revoke works; no remote privilege |
| CLI-08 | Scoped worker API authorization with household isolation | `AcceptedRuntime` | `server/src/network/{authz,gateway_auth}.rs` | Unknown scope, command or household gets uniform denial |
| CLI-09 | Query-log richness: protocol, cache, upstream, time, flags, reason, rule and service attributes | `PartialRuntime` | [observe.rs](../crates/family-dns/src/observe.rs) bounded in-process records | Durable entry carries protocol, upstream, reason and rule text; no URLs stored |
| CLI-10 | Time-bounded retention, anonymisation flag and ignored hosts | `PartialRuntime` | count-bounded ring only; retention field carried but unwired | 24h retention prunes; anonymisation and ignore lists honoured |
| CLI-11 | Query-log search and pagination | `Missing` | none | Paginated search by domain, client and reason |
| CLI-12 | Test-domain check-host endpoint | `PartialRuntime` | in-process decision view, no endpoint | Endpoint returns rule id and reason for a blocked name |
| CLI-13 | Top clients/domains stats with windows and reset | `Missing` | none | 1h/24h windows return counts; reset zeroes them |

## G. Configuration, operations and platform

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| OPS-01 | Bounded atomic reload with same transport and monotonic revision | `AcceptedRuntime` | [server.rs](../crates/family-dns/src/server.rs), [bundle.rs](../crates/family-dns/src/bundle.rs) | Reload swaps one snapshot; transport-changing reload rejected |
| OPS-02 | Durable config+policy bundle outside the database, with restart recovery | `AcceptedRuntime` | [bundle.rs](../crates/family-dns/src/bundle.rs), durable tests | Changed-config abrupt restart recovers; invalid payload keeps last-known-good |
| OPS-03 | Bounded HTTPS controller policy pull, verified and applied locally | `InProgress` | [controller.rs](../crates/family-dns/src/controller.rs) (committed, independent review pending) | Schema, scope, revision, publication time and digest verified; failure keeps last-known-good; no ack claimed |
| OPS-04 | Application acknowledgment and independent coverage verification | `Missing` | none | Worker reports applied revision; verifier checks coverage; no stale protected badge |
| OPS-05 | Config backup/restore reusing the existing encrypted flow, including DNS state | `PartialRuntime` | `tools/secure_backup.py`, operations runbook | Restore returns bundle and policy state; key custody handled separately |
| OPS-06 | Dependency, package and recovery updates tracked through existing flows | `PartialRuntime` | pinned toolchain and existing update flow | Update diff reviewed; recovery path verified; no new self-updater |
| OPS-07 | DNS TLS key custody and verification health, separate from proxy PKI | `Missing` | proxy PKI is accepted but scope-limited | Cert expiry/hostname health reported; no verification bypass |
| OPS-08 | Native worker lifecycles and portable packaging | `PartialRuntime` | [bin/vantyr-dns.rs](../crates/family-dns/src/bin/vantyr-dns.rs), proxy worker | Each worker starts/stops independently; no socket survives shutdown; no host deploy implied |
| OPS-09 | Truthful capability and health reporting | `PartialRuntime` | worker-local capability labels | Unsupported/unknown reported, never a stale protected state |
| OPS-10 | Kernel `ipset` helper integration as a platform aid, not a user exclusion | `NeedsPlatformDecision` | none | Platform decision recorded first; no host deployment from this work |
| OPS-11 | DHCP server function | `Excluded` | none | Router keeps assigning addresses; no lease or router change |
| OPS-12 | Frontend and mobile clients | `Excluded` | none | UI remains user-owned; mobile deferred |
| OPS-13 | Worker authentication via existing identity and grants | `AcceptedRuntime` | `server/src/network/{authz,gateway_auth}.rs` | Scoped grants drive all worker calls; no separate login or cloned endpoint |
| OPS-14 | DNS self-updater and release publication | `Excluded` | none | No DNS self-update path and no release is created by this catalog |

## Bounded implementation sequence

Stages are ordered by dependency. A stage is `PartialRuntime` until **every**
row it gates reaches `AcceptedRuntime` with the listed acceptance test passing;
a `LibraryOnly` or `InProgress` row never closes a stage. Each stage reuses the
previous one's snapshot and keeps deny-default, no fail-open and no TLS bypass.

| Stage | Rows gated | Depends on | Exit condition |
|---|---|---|---|
| 1 | FLT-02, FLT-03, SUB-01, SUB-02, SUB-03 | Accepted snapshot and bundle (OPS-01/02) | One snapshot compiles, validates and atomically swaps list/compiled bytes with last-known-good on failure; full modifier scope retained |
| 2 | CAC-01, CAC-02, CAC-03, CAC-04, CAC-06, CAC-07, CAC-08, CAC-09, CAC-12 | Stage 1 | Each response-shaping contract tested; CAC-04 explicitly asserts no validator claim; CAC-05/FLT-11 decisions recorded separately |
| 3 | CLI-02, CLI-03, CLI-05, CLI-06, CLI-09, CLI-10, CLI-11, CLI-12, CLI-13, OPS-04 | Stages 1–2 | Bounded durable log and client breadth pass while deny-default and spoof guards hold; acks verified |
| 4 | UP-02, UP-03, UP-04, UP-05, UP-06, UP-07, UP-08 | Stage 1 | Each upstream scheme and selection mode tested; TLS failures fail closed |
| 5 | LST-03, LST-04, LST-05, LST-06, LST-07, LST-08 | Stage 4 and OPS-07 | All server transports, including DNSCrypt, plus separate DNS cert lifecycle pass |
| 6 | FLT-05, FLT-07, FLT-08, FLT-10, SUB-05, SUB-06, SUB-07, LST-01 | Stages 3–5 | Rewrites, aliases, services and real SafeSearch/feed providers accepted with provenance |
| 7 | OPS-10 | Explicit platform decision | Helper adopted only after decision; still no host deploy from this work |
