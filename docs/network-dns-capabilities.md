# First-party DNS capability catalog and acceptance gate

This document is the neutral, current-state delivery gate for the Vantyr DNS
worker and its control plane. It records behavior contracts, honest status and
the acceptance evidence required to close each row. It is not a roadmap history or
a deployment claim. The initial source audit used commit `cd4d4029`; later
implementation commits are identified below where relevant. In-flight or
unreviewed code does not close a row. No deploy, release or host-network change follows from this catalog.

**Status legend.** `AcceptedRuntime` = implemented, tested and independently
accepted in local source. `PartialRuntime` = some of the contract is served, a
named part is not. `LibraryOnly` = a local library implements a subset but no
worker consumes it. `InProgress` = committed-but-unreviewed or uncommitted
working-tree work; not accepted. `Missing` = no local implementation.
`Excluded` = deliberately outside this product's scope. `NeedsPlatformDecision`
= platform/security enhancement requiring an explicit decision before work.

**Non-negotiable boundaries for every row.** No blanket TLS-verification skip
anywhere; verification failures retain last-known-good policy, while queries
whose upstream verification fails receive an error rather than an unverified answer. No fail-open
when trust, policy age or state is unknown: the household baseline stays deny
and new allows require verified state. No person, adult status or privilege is
inferred from an IP, a public address or a spoofed client label; device and
observation identity are weak evidence only. Router DHCP is retained by the
operator; this work never assigns addresses or edits router/firewall state.
The UI is user-owned and mobile is deferred. Dashboard administration uses
existing OIDC sessions and explicit household grants. Workers use a separate
audience-scoped Bearer credential and cookie-free `/worker/network` routes;
worker authentication never establishes a verified person session. Existing
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
| LST-02 | IPv4-mapped source canonicalisation and RD/CD request flags on allowed, NXDOMAIN, REFUSED and sinkhole paths | `AcceptedRuntime` | [handler.rs](../crates/family-dns/src/handler.rs), [functional.rs](../crates/family-dns/tests/functional.rs) | Mapped source selects the plain-IPv4 device profile; RD/CD echoed on every path |
| LST-03 | DoT server listener with policy applied to decrypted queries | `AcceptedRuntime` | Explicit operator `dot_listener`, shared Hickory handler, protected cert/key loading and actual TLS verification; accepted through `1dfceace`, nine real listener tests cover policy/flags, trust/hostname rejection, private-key failures, durable startup/restart, CIDR behavior and shutdown | Client trusting the configured server CA connects; denied query refused; untrusted client rejects the server chain |
| LST-04 | DoH server with GET/POST query route and per-client path form | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) explicit `doh_listener` (default off, one bounded hostname/path), [dot.rs](../crates/family-dns/src/dot.rs) shared protected custody, [server.rs](../crates/family-dns/src/server.rs) pinned Hickory h2 listener on the shared handler; GET base64url and POST `application/dns-message` answered with policy/flags, source from the socket only. Per-client path identities and trusted-proxy mapping remain future | DoH POST and GET answered; per-client route uses the right profile (second half remains unmet) |
| LST-05 | DoQ server listener | `Missing` | none in `crates/family-dns` | QUIC query answered with policy applied; transport failure fails closed |
| LST-06 | DNSCrypt server, including disabled state at zero port | `Missing` | none in `crates/family-dns` | DNSCrypt query answered; port zero leaves no listener |
| LST-07 | HTTP/3 transport for encrypted DNS, with and without fallback | `Missing` | none in `crates/family-dns` | H3 query answered; fallback path behaves as configured |
| LST-08 | DNS server certificate lifecycle: protected key loading, certificate/key consistency, expiry checks and atomic reload; separate from proxy PKI | `PartialRuntime` | Accepted startup custody, cert/key consistency and validity for both DoT and DoH via one shared preparation path; transport changes require restart. Atomic in-process certificate rotation remains open; proxy PKI stays separate | Replace certificate/key, reload, client verifies new server chain and intended hostname; invalid key/cert or expired replacement rejected without replacing the active configuration |
| LST-09 | Self-loop and public-bind guards reject unsafe listener/upstream combinations | `AcceptedRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs), [config.rs](../crates/family-dns/src/config.rs) | Mapped and plain self-loop rejected before a listener exists; non-loopback needs opt-in |

## B. Upstream resolution and routing

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| UP-01 | Plain UDP/TCP forwarding plus authoritative local zones, A/AAAA/CNAME and SOA | `AcceptedRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs), [handler.rs](../crates/family-dns/src/handler.rs) | Local zone, forwarded answer and negative SOA each returned through the handler |
| UP-02 | Encrypted upstream schemes (DoT, DoH, DoQ, DNSCrypt, H3) | `PartialRuntime` | Accepted `d59e99e1`: [upstream.rs](../crates/family-dns/src/upstream.rs) provides verified DoT/DoH using literal bootstrap and separate verification hostname; shared CA pool. DoQ/DNSCrypt/H3 remain missing | Route one query per scheme; certificate failure keeps last-known-good policy and answers fail closed |
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
| CAC-01 | Positive/negative cache toggle, size and TTL min/max bounds | `PartialRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs) applies configurable bounds; HTTP desired cache enable/size/TTL is now delivered by schema-v2 management and applied by the worker in one durable bundle, with origin-hit proof. Eventual response-count eviction only, no byte bound; operator-local hosts/bogus-IP/HTTPS hints remain local | Configure bounds via the v2 wire; TTL 1s and very large TTL clamped; disabled cache yields no hits |
| CAC-02 | Optimistic cache serve with bounded answer TTL while refreshing | `Missing` | none | Expired entry served at configured short TTL during refresh |
| CAC-03 | Cache clear operation | `PartialRuntime` | [server.rs](../crates/family-dns/src/server.rs) clears the current resolver cache without a generation bump; a scoped admin command now delivers one token per household through the worker read and records truthful request/delivery/attempt/ack per gateway; in-flight queries may still repopulate | Clear then re-query hits upstream, not cache |
| CAC-04 | DNSSEC request option (DO) configuration, kept separate from response header-flag preservation already accepted in LST-02 and from a validator | `Missing` | no DO configuration; allowed responses carry upstream metadata; denial responses construct fresh metadata; only RD/CD specifically asserted | DO set or absent as configured on upstream query; RD/CD regression checks preserved; no AD-specific acceptance or local validator claimed |
| CAC-05 | Full local DNSSEC validator | `NeedsPlatformDecision` | none | Security enhancement only: if adopted, signed chain validated and bogus refused; decision recorded before work |
| CAC-06 | EDNS Client Subnet, default off, with explicit opt-in and custom override | `Missing` | none | Default adds no ECS option; opt-in adds real subnet; custom overrides; log records ECS |
| CAC-07 | Disable IPv6 answers and strip IPv6 hints from related answers | `PartialRuntime` | [handler.rs](../crates/family-dns/src/handler.rs) strips AAAA in all sections; HTTPS/SVCB IPv6 hints remain unsupported | AAAA returns empty; HTTPS hints stripped |
| CAC-08 | Optional system hosts-file resolution | `AcceptedRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs) explicit default-off hosts lookup on plaintext/encrypted paths; maintained in-memory hosts injection tests retain policy checks | Enabled hosts entry resolves locally; disabled does not |
| CAC-09 | Bogus-NXDOMAIN by answer IP list | `PartialRuntime` | [handler.rs](../crates/family-dns/src/handler.rs) matches bounded configured A/AAAA IPs in every section, returns empty NXDOMAIN; HTTPS/SVCB hints are not inspected | Response containing configured IP becomes NXDOMAIN |
| CAC-10 | Null/custom-IP denial with configurable TTL | `AcceptedRuntime` | [config.rs](../crates/family-dns/src/config.rs) `DenyConfig::Sinkhole`, [handler.rs](../crates/family-dns/src/handler.rs) | Sinkhole to 0.0.0.0, :: or custom IP returns configured TTL; no alias-mode API is required |
| CAC-11 | Denial modes NXDOMAIN and REFUSED with validation | `AcceptedRuntime` | [config.rs](../crates/family-dns/src/config.rs), [functional.rs](../crates/family-dns/tests/functional.rs) | Both modes configurable; invalid sinkhole config rejected at startup |
| CAC-12 | Per-subnet rate limit, CIDR whitelist and ANY amplification refusal | `Missing` | [runtime.rs](../crates/family-dns/src/runtime.rs) only has a global active-request cap | Subnet QPS cap enforced; whitelist exempt; ANY refused |

## D. Filter syntax, rewrites and aliases

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| FLT-01 | Hosts-file and bare-domain lines; exact, suffix and any matchers with diagnostics | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) `MatchSpec` and its tests | Host/domain lines compile and match; unknown fields rejected |
| FLT-02 | Maintained-list notation (double-pipe host anchor, exception, regex, wildcard) compiled with honest diagnostics | `PartialRuntime` | `crates/network-filter/src/{hosts,abp,hostname_regex}.rs` and `crates/family-dns/src/filter.rs`; bounded hostname regex block/exception/important-block rules accepted through `02753b27`, compiler and real UDP/TCP/restart tests pass. Important regex exceptions and broader pattern/modifier coverage remain open; URL/path semantics stay outside DNS | Domain anchors, exceptions, regex and wildcards each demonstrate their specified DNS semantics with bounded diagnostics; unsupported pattern forms must remain explicit |
| FLT-03 | Full context-modifier scope: client, ctag, denyallow, dnstype, dnsrewrite, important, badfilter | `InProgress` | `crates/network-filter/src/abp.rs` currently accepts only the importance modifier and rejects the rest | Each listed modifier changes a real worker decision with its required context; unsupported modifiers produce diagnostics but do not satisfy this row; no silent match or reduction of scope |
| FLT-04 | Deny-over-allow precedence inside a profile, with safety-first tie handling | `AcceptedRuntime` | `crates/family-policy/src/eval.rs`, [functional.rs](../crates/family-dns/tests/functional.rs) | Matching deny wins over allow; no exception silently grants adult access |
| FLT-05 | Per-client and tag-scoped rule selection | `Missing` | DNS sees source IP only; [policy.rs](../crates/family-dns/src/policy.rs) has no session | Tag rule applies only to tagged device; spoofed label cannot select an adult profile |
| FLT-06 | Schedules with timezone and DST handling for profiles and rules | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) `ScheduleSpec`, `crates/family-policy/src/eval.rs` | Window enforced in local time including DST fold; service/client schedules remain ungated |
| FLT-07 | Local wildcard records and explicit A/AAAA/CNAME/SOA/TXT/MX/SRV/NS/PTR/CAA/SVCB/HTTPS RR support with keep-upstream values | `PartialRuntime` | [runtime.rs](../crates/family-dns/src/runtime.rs) A/AAAA/CNAME/SOA; no wildcard or keep-upstream | Wildcard answers tested for each listed RR type; A/AAAA keep-upstream preserves the selected original RRsets and policy |
| FLT-08 | Rewrite suppression forms (NODATA, NXDOMAIN, REFUSED) and explicit A/AAAA/CNAME/SOA/TXT/MX/SRV/NS/PTR/CAA/SVCB/HTTPS values | `PartialRuntime` | Accepted exact-domain operator `Config.rewrites` A/AAAA/CNAME slice through `8dfc813e`, real UDP/TCP and reload/restart tests; question and canonical-target denials remain authoritative. Unmatched types yield NODATA. Filter-text syntax, configured suppression forms, broader types, HTTP and UI remain open | Every listed RR type rewritten correctly; each suppression form produces the correct rcode and answer/authority shape |
| FLT-09 | Alias-chain denial for CNAME and differing-owner A/AAAA | `AcceptedRuntime` | [handler.rs](../crates/family-dns/src/handler.rs) | Allowed alias resolving to a denied target becomes the configured denial with evidence |
| FLT-10 | Alias breadth for SVCB, HTTPS, DNAME and TSIG-signed queries | `Missing` | excluded in [handler.rs](../crates/family-dns/src/handler.rs) header comment | SVCB/HTTPS/DNAME targets cannot bypass denial; TSIG-authenticated queries are verified and handled without invalidating authentication or bypassing policy; unsupported forms leave the row open |
| FLT-11 | Built-in rebinding protection | `NeedsPlatformDecision` | none | Security enhancement only; explicit decision needed, no parity claim |

## E. Public list subscriptions, services and SafeSearch

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| SUB-01 | Public list URL add/remove/set and explicit enable/disable | `AcceptedRuntime` | [dns_management_api.rs](../server/src/network/dns_management_api.rs) and `crates/family-dns/src/{management_worker,subscription}.rs`; accepted scoped HTTP desired config plus worker pull/application | Operator URL ingested, compiled and enforced by a worker snapshot |
| SUB-02 | Interval, manual refresh, conditional GET, last-known-good, count, dedup, freshness, status and declared source/licence | `PartialRuntime` | Accepted fetcher/cache/scheduler, HTTP interval/manual/status controls and operator-declared source/licence metadata; comprehensive cross-source deduplication acceptance remains open | 304 then 200; 500/malformed keeps last-known-good; status reports fresh/error/disabled truthfully |
| SUB-03 | Worker consumes fetched bytes through compile, validate and atomic swap | `AcceptedRuntime` | `crates/family-dns/src/subscription.rs` and `server.rs`, accepted `39c467e9` + `7027b7da`; real background loop, generation guard and restart tests | A refreshed list changes answers; a failed refresh leaves answers unchanged |
| SUB-04 | Diagnostics and test-host lookup returning reason, rule text and service attributes | `Missing` | in-process decision view only | Endpoint reports why blocked with matched rule text; URL history never stored |
| SUB-05 | Curated service catalog with declared source/provider, selected IDs only, domain coverage that is partial and not app identity | `PartialRuntime` | Accepted operator-declared catalogue, service selection and real DNS-domain tests; a curated provider-backed service feed is still missing | Named service blocks its domains, unknown ID rejected, provenance/licence recorded truthfully |
| SUB-06 | SafeSearch per engine, including YouTube restricted mode, using real declared providers | `PartialRuntime` | Accepted global and per-device operator settings through `103feb36`, `safe_search.rs` + `safe_search_catalog.rs`: 187 exact Google www owners including AU/NZ, two Bing owners, and five YouTube aliases with off/moderate/strict selection; official hostname targets resolved through maintained resolver. Independent validation passed forty integration and sixteen filtered library tests plus strict clippy. The integrated listener/SafeSearch targets passed forty-two tests including durable override restart. Google catalog is a reviewed 2026-11-27 snapshot. HTTP/UI management remains open | Search/image/video engine domains rewritten per client; YouTube restricted mode enforced; no fabricated provider |
| SUB-07 | Parental and malicious-domain feeds with real provider, licence and recovery behaviour | `Missing` | none | Feed domain blocked with correct reason; provider unavailable keeps last-known-good |

## F. Clients, protection and observability

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| CLI-01 | Exact-IP device mapping including IPv4-mapped sources | `AcceptedRuntime` | [config.rs](../crates/family-dns/src/config.rs), [functional.rs](../crates/family-dns/tests/functional.rs) | Mapped and plain source select the same device profile |
| CLI-02 | Client identity breadth: CIDR ranges, observed MAC, observed client ID, weak labels | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) stores exact source IPs and CIDR source ranges with exact-IP priority, longest-prefix match and bounded conflict rejection; observed MAC, client ID and weak labels remain | CIDR selects profile; observed MAC selects only when actually observed; no public-IP person inference |
| CLI-03 | Per-client tags, upstreams, log-ignore, stats-ignore and cache controls | `Missing` | none | Tagged client uses its upstreams and is omitted from log/stats when configured |
| CLI-04 | Current IP-mapped DNS path never infers person privileges; person rules require verified state | `AcceptedRuntime` | [compile.rs](../crates/family-dns/src/compile.rs), [policy.rs](../crates/family-dns/src/policy.rs) | Unverified person rule rejected by controller compilation; unknown source stays restricted; future encrypted client IDs/headers require separate end-to-end spoof tests under LST-04/UP-08 |
| CLI-05 | Global and per-device protection pause with expiring scoped exception | `Missing` | always enforcing; stale policy fails closed | Pause expires and enforcement resumes; baseline deny cannot be silently disabled |
| CLI-06 | Explicit allow/deny client lists and blocked-host handling | `PartialRuntime` | [config.rs](../crates/family-dns/src/config.rs) only has restrictive unknown default | Explicit allow/deny lists applied; blocked hosts answered or dropped as configured |
| CLI-07 | BYOD enrollment using existing OIDC identity and scoped grants | `AcceptedRuntime` | `server/src/network/enroll_*`, migration `0078` (`3afcb9fc` + `db942852`, independent review: 66 network tests) | Single-use grant binds authorized device, admin-mapped OIDC principal, expiry and purpose; revocation works; no runtime DNS/proxy identity or remote privilege claimed |
| CLI-08 | Scoped worker API authorization with household isolation | `AcceptedRuntime` | `server/src/network/{authz,gateway_auth}.rs` | Unknown scope, command or household gets uniform denial |
| CLI-09 | Query-log richness: protocol, cache, upstream, time, flags, reason, rule and service attributes | `PartialRuntime` | [events.rs](../crates/family-dns/src/events.rs) opt-in final-query reporting and durable scoped server reads; actual protocol/flags/rules, cache/upstream identity explicitly unknown | Durable entry carries protocol, upstream, reason and rule text; no URLs stored |
| CLI-10 | Time-bounded retention, anonymisation flag and ignored hosts | `PartialRuntime` | server age/count retention on ingestion and idle sweeps; worker volatile queue has explicit loss counters; anonymisation and ignore lists remain open | 24h retention prunes; anonymisation and ignore lists honoured |
| CLI-11 | Query-log search and pagination | `AcceptedRuntime` | [dns_events_service.rs](../server/src/network/dns_events_service.rs) scoped DNS-only search, keyset/offset pagination, microsecond cursors; real worker/TLS/PG integration reviewed | Paginated search by domain, client and reason |
| CLI-12 | Test-domain check-host endpoint | `PartialRuntime` | in-process decision view, no endpoint | Endpoint returns rule id and reason for a blocked name |
| CLI-13 | Top clients/domains stats with windows and reset | `PartialRuntime` | scoped received-observation statistics for 1h/24h/7d/30d; conservative retained-history warning; reset remains missing | 1h/24h windows return counts; reset zeroes them |

## G. Configuration, operations and platform

| ID | Behavior contract | Status | Local code | Acceptance test |
|---|---|---|---|---|
| OPS-01 | Bounded atomic reload with same transport and monotonic revision | `AcceptedRuntime` | [server.rs](../crates/family-dns/src/server.rs), [bundle.rs](../crates/family-dns/src/bundle.rs) | Reload swaps one snapshot; transport-changing reload rejected |
| OPS-02 | Durable config+policy bundle outside the database, with restart recovery | `AcceptedRuntime` | [bundle.rs](../crates/family-dns/src/bundle.rs), durable tests | Changed-config abrupt restart recovers; invalid payload keeps last-known-good |
| OPS-03 | Bounded HTTPS controller policy pull, verified and applied locally | `AcceptedRuntime` | [controller.rs](../crates/family-dns/src/controller.rs) (`83c7bce3` + `567f1e0e`, independent review: 48 DNS tests) | Schema, scope, revision, publication time and digest verified; failure keeps last-known-good; no ack claimed |
| OPS-04 | Application acknowledgment and independent coverage verification | `PartialRuntime` | Authenticated worker-reported management apply state in [dns_management_service.rs](../server/src/network/dns_management_service.rs); independent canary/coverage verification remains missing | Worker reports applied revision; verifier checks coverage; no stale protected badge |
| OPS-05 | Config backup/restore reusing the existing encrypted flow, including DNS state | `PartialRuntime` | `tools/secure_backup.py`, operations runbook | Restore returns bundle and policy state; key custody handled separately |
| OPS-06 | Dependency, package and recovery updates tracked through existing flows | `PartialRuntime` | pinned toolchain and existing update flow | Update diff reviewed; recovery path verified; no new self-updater |
| OPS-07 | DNS TLS key custody and verification health, separate from proxy PKI | `Missing` | proxy PKI is accepted but scope-limited | Cert expiry/hostname health reported; no verification bypass |
| OPS-08 | Native worker lifecycles and portable packaging | `PartialRuntime` | [bin/vantyr-dns.rs](../crates/family-dns/src/bin/vantyr-dns.rs), proxy worker | Each worker starts/stops independently; no socket survives shutdown; no host deploy implied |
| OPS-09 | Truthful capability and health reporting | `PartialRuntime` | Scoped supported/desired/delivered/downloaded/worker-reported-applied views; v2 now reports only runtime-supported cache enable/size/TTL, response mode/denial TTL and cache clear, with no entries count or generation claim; no verified coverage signal | Unsupported/unknown reported, never a stale protected state |
| OPS-10 | Kernel `ipset` helper integration as a platform aid, not a user exclusion | `NeedsPlatformDecision` | none | Platform decision recorded first; no host deployment from this work |
| OPS-11 | DHCP server function | `Excluded` | none | Router keeps assigning addresses; no lease or router change |
| OPS-12 | Frontend and mobile clients | `Excluded` | none | UI remains user-owned; mobile deferred |
| OPS-13 | Separate scoped worker Bearer authentication, issued through household-authorized administration | `AcceptedRuntime` | `server/src/network/{authz,gateway_auth}.rs` | Dashboard cookie alone cannot authenticate a worker call; Bearer audience/command/household/gateway/kind/expiry/revocation checked; worker Bearer cannot authenticate dashboard routes |
| OPS-14 | DNS self-updater and release publication | `Excluded` | none | No DNS self-update path and no release is created by this catalog |

## Bounded implementation sequence

Stages group bounded work; independent groups may run in parallel. A stage stays
`PartialRuntime` until every required row it gates is `AcceptedRuntime`; rejection
of an unsupported feature does not close its positive behavior contract.
Dependencies below identify actual shared contracts, not a mandatory serial order.
Platform decisions have their own recorded outcomes and cannot silently remove
required rows. Existing partial operational rows remain open even after a stage
has delivered its narrower feature group.

| Stage | Rows gated | Depends on | Exit condition |
|---|---|---|---|
| 1 | FLT-01, FLT-02, FLT-03, SUB-01, SUB-02, SUB-03, SUB-04 | Accepted snapshot and bundle (OPS-01/02) | List refresh compiles, validates and swaps atomically with last-known-good on failure; full required syntax/modifier behavior demonstrated |
| 2 | CAC-01, CAC-02, CAC-03, CAC-04, CAC-06, CAC-07, CAC-08, CAC-09, CAC-12 | Accepted snapshot and bundle (OPS-01/02) | Every response/cache contract tested; no local DNSSEC-validator claim; independent of list parsing |
| 3 | CLI-02, CLI-03, CLI-04, CLI-05, CLI-06, CLI-07, CLI-09, CLI-10, CLI-11, CLI-12, CLI-13, OPS-04, OPS-09 | Accepted scoped inventory/auth and snapshot; modifier/tag consumers require the relevant Stage 1 rows | Durable logs/client controls and independent ack/coverage checks pass; transport-header spoof tests also require LST-04/UP-08 |
| 4 | UP-02, UP-03, UP-04, UP-05, UP-06, UP-07, UP-08 | Accepted snapshot and bundle (OPS-01/02); UP-08 exercised with LST-04 | Each upstream scheme/selection mode tested; verification failures fail closed; no dependency on list-modifier breadth |
| 5 | LST-01, LST-03, LST-04, LST-05, LST-06, LST-07, LST-08, OPS-07 | Accepted policy handler and snapshot; OPS-07 custody implemented alongside LST-08 | Every listener plus separate DNS key custody, certificate reload and verification health passes; upstream transport work may proceed independently |
| 6 | FLT-05, FLT-06, FLT-07, FLT-08, FLT-10, SUB-05, SUB-06, SUB-07 | Relevant client/tag context for FLT-05; Stage 1 compiler/source contracts for service/feed consumers; accepted snapshot for rewrites | All enumerated rewrites/aliases, schedules, service coverage and real providers pass with provenance; unrelated listeners are not prerequisites |
| 7 | OPS-05, OPS-06, OPS-08, OPS-10, CAC-05, FLT-11 | Accepted feature artifacts for recovery/packaging; decisions recorded within this stage for the three NeedsPlatformDecision rows | Recovery/update/lifecycle checks pass; each platform decision records adoption or reasoned deferral; required runtime rows cannot be waived through this stage; no host deployment implied |
