# Vantyr Network — backend implementation checklist

## Current delivery status

- Shared policy core: independently accepted; 16 tests.
- DNS immutable snapshots: independently accepted; no catalog lock across I/O.
- Vantyr DNS executable and durable configuration/reload: independently accepted;
  34 baseline tests. Controller-driven HTTPS policy retrieval/application is
  committed with 47 tests reported passing and awaits independent acceptance.
- Network runtime: independently accepted; 23 tests covering typed process-restart
  persistence and bounded events. Persistence is integrated into DNS; event-queue
  integration into the DNS/query-log pipeline remains unfinished.
- Isolated DNS lab: independently accepted with actual worker queries, reload,
  changed-config abrupt-restart recovery, stale-policy behavior and verified
  cleanup. It makes no household deployment or controller-acknowledgment claim.
- Management API: inventory, scoped grants, gateway credentials/heartbeat and
  versioned policy retrieval are independently accepted. BYOD enrollment is
  under implementation; worker acknowledgment and coverage verification remain.
- Vantyr Proxy: authenticated HTTP/CONNECT and optional scoped HTTPS inspection
  are independently accepted; 55 proxy tests and 23 PKI tests. Client credential
  enrollment, reversible setup and trust installation remain unfinished.
- UniFi: read-only discovery and a pure setup planner are independently accepted;
  25 tests. Live-controller validation and server integration remain unfinished.
- Management UI: proceeds in a separate thread; mobile apps remain deferred.
- DHCP serving is excluded. The router continues assigning addresses.

The integration checkpoints at the end of this document record current acceptance
evidence. The original foundation notes below are historical and must not be used
as a current capability summary. The granular first-party
[DNS capability catalog](network-dns-capabilities.md) is committed and undergoing
independent review as the delivery gate; partial implementations do not close a row.

Foundation checkpoint: **step 1 only**. Backend feasibility and durable contracts. No live
household, DHCP, router, firewall, DNS resolver, proxy, Supabase or React UI
changes. The integrated Network UI is deliberately deferred and is not a
prerequisite for backend work.

Related docs: [operations/security runbook](family-network-operations.md) and
[BYOD onboarding roadmap](network-onboarding.md)
(accepted). The full native DNS behaviour scope is listed neutrally below
and remains future work; none of it overrides Vantyr's scope/OIDC boundaries.

## Historical step-1 foundation checkpoint

1. A pure policy crate (`family-policy`) with the shared data contracts and a
   deterministic evaluator, including 16 passing tests.
2. A Hickory DNS worker crate (`family-dns`) with 3 passing loopback tests:
   UDP+TCP A/AAAA/CNAME/NXDOMAIN/TTL, caller-supplied sinkhole zone revisions,
   and forwarding to a loopback upstream. Policy evaluation is not yet wired
   into this worker.
3. A Rama 0.4 proxy compatibility crate (`family-proxy`) with 5 passing
   service-level tests: egress-before-CONNECT-ack, denial of metadata/private/
   literal destinations without dialling, malformed CONNECT rejection,
   `Proxy-Authorization` stripping, unique CA custody.
4. An executable spike binary (`gateway-compat-spike`) that runs and prints a
   real TV/shared-device policy decision and destination-policy checks.
5. Pinned dependency versions/features in `Cargo.toml` and an updated
   `Cargo.lock`.

At that checkpoint there was no running proxy listener or TLS inspection.
Those capabilities now have separate acceptance evidence below. The full DNS
capability set and the independently managed frontend remain unfinished.

## Reproducible commands (run from repo root)

```
cargo test -p family-policy
cargo test -p family-dns
cargo test -p family-proxy
cargo run  -p gateway-compat-spike
```

Recorded results in this checkout: `family-policy` 16 passed / 0 failed;
`family-dns` 3 passed / 0 failed; `family-proxy` 5 passed / 0 failed; spike
binary exits 0 and prints `device_profile_deny` for the TV example. All
listeners used in tests are `127.0.0.1:0` ephemeral sockets; no privileged
ports, no host resolver/DHCP changes.

### Actual crate API/source paths (avoid rediscovery)

Versions are pinned exactly in each crate manifest:

| Crate | Pinned version | Features used |
|---|---|---|
| `hickory-server` | `=0.26.4` | `resolver` |
| `hickory-resolver` | `=0.26.4` | `tokio`, `serde` (defaults off) |
| `rama` | `=0.4.0` | `std`, `net`, `tcp`, `dns`, `dns-hickory`, `http-full`, `tls`, `rustls`, `ring`, `proxy` |
| `rcgen` | `=0.14.10` | `crypto`, `pem`, `ring`, `x509-parser` |
| `rustls` | `=0.23.46` | `ring`, `std`, `tls12`, `logging` |
| Hudsucker | `=0.25.0` | **evaluated and removed** — see blocker below |

`time` remains at `0.3.47` rather than the previous `0.3.55`: pinned Rama
0.4.0 requires `time = "=0.3.47"`, so the older version is unavoidable for
this backend. `tokio-util` was returned to the pre-existing `0.7.20` by
dropping an unnecessary exact pin in `family-dns`.

Source roots under `~/.cargo/registry/src/index.crates.io-<hash>/`:

- `hickory-server-0.26.4/src/server/mod.rs` — `Server::new`, `register_socket`,
  `register_listener`, `shutdown_token`, `block_until_done`.
- `hickory-server-0.26.4/src/zone_handler/catalog.rs` — `Catalog::upsert`,
  `RequestHandler for Catalog` (generic `handle_request::<R,T>`).
- `hickory-server-0.26.4/src/store/in_memory/mod.rs` — `InMemoryZoneHandler::new`
  (requires `SOA`, explicit `TokioRuntimeProvider` type annotation).
- `hickory-server-0.26.4/src/store/forwarder.rs` — `ForwardZoneHandler`,
  `ForwardConfig`; name-server ports must be set on `ConnectionConfig.port`
  (the constructors default to port 53).
- `hickory-resolver-0.26.4/src/config.rs` — `ResolverConfig::from_name_servers`,
  `NameServerConfig::udp_and_tcp/tcp`, `ResolveHosts::Never`,
  `LookupIpStrategy`; `ResolverBuilder::options_mut` (there is no `.options()`).
- `hickory-proto-0.26.4/src/rr/record.rs` — `Record::from_rdata`; `Record.name`
  and `Record.ttl` are public **fields**, not methods.
- `rama-http-0.4.0/src/layer/upgrade/layer.rs` — `UpgradeLayer::new`.
- `rama-http-0.4.0/src/layer/upgrade/http_proxy_connect/eager.rs` —
  `EagerHttpProxyConnector::new`; egress is dialled before CONNECT ack.
- `rama-dns-0.4.0/src/client/connector.rs` — `DnsConnector::with_resolver`;
  **IP literals bypass the resolver** and are forwarded untouched.
- `rama-net-0.4.0/src/client/connect_request.rs` — `ConnectRequest.authority`.
- `rama-core-0.4.0/src/service/handler.rs` — `service_fn`.

Lessons that cost a build cycle: `tokio-util` CancellationToken is behind the
`rt` feature (not `sync`); holding a `std::sync::RwLock` guard across `.await`
in a `RequestHandler` makes the future non-`Send` (use `tokio::sync::Mutex`);
`ResolverConfig::new()` does not exist in Hickory 0.26.

## Backend decision (why one engine, not two)

Hudsucker 0.25 was the initial preferred proxy. Source verification found a
concrete blocker in `hudsucker-0.25.0/src/proxy/internal.rs`: around lines
282–310 an unknown-protocol branch after CONNECT and the
`should_intercept_tls == false` branch both call
`TcpStream::connect(authority.as_ref())` using system DNS, bypassing the custom
connector and any validated destination. `normalize_request` (line 488) also
does not strip `Proxy-Authorization`. Blocking every tunnel or using IP-only
CONNECT is not acceptable final behaviour because the product needs scoped
no-inspection exceptions. Therefore **Rama 0.4.0 is the single proxy engine**
in the dependency graph; Hudsucker is not a dependency. This is a bounded
compatibility decision, not a claim that the full proxy is built.

Rama facts verified from pinned 0.4.0 source: `EagerHttpProxyConnector`
establishes egress before acknowledging CONNECT and maps failure to 502/504;
`DnsConnector` passes IP literals straight through, so destination
validation must additionally reject literals rather than relying on the
resolver. Rama 0.4 has no `RustlsMitmCertIssuer` (only BoringSSL);
`HttpMitmRelay` is not a TLS terminator. A small rcgen leaf issuer plus rustls
termination remains future work.

## Eight bounded steps

1. **Compatibility scaffold (THIS STEP — complete).** Pure policy contracts,
   Hickory worker tests, Rama CONNECT/destination tests, pinned deps, spike
   binary, durable docs. No UI, no Supabase, no host network changes.
2. **Backend API contract freeze (next).** Turn the structs in this doc into
   versioned JSON contracts behind the central API; define worker credential
   shape (separate `GatewayCredential`), scoped commands, canary/ack protocol
   and bounded event retention. Still no UI.
3. **Native DNS backend capability slices.** Work from the full behaviour list
   below one slice at a time: filtered forwarding, local/split DNS, filter
   syntax and client grouping first; encrypted DNS remains in scope.
   DHCP address assignment stays on the router and is outside this product. Validate each slice on one test device
   before any broader use.
4. **Pure policy evaluation hardening.** More precedence/expiry/schedule
   tests, then wire the effective policy snapshot into the DNS worker. No
   protocol-engine feature work in this step.
5. **Rama proxy egress hardening.** Real network listener on loopback, custom
   `DnsAddressResolver` that validates every candidate IP, pinned destination
   register, timeout/connection limits, and upstream rustls verification with
   webpki roots. Add a real bad-certificate/bad-hostname egress test (NOT a DNS
   rejection test standing in for certificate validation).
6. **TLS inspection slice.** Small rcgen leaf issuer + rustls termination with
   a per-installation CA, unique custody, encrypted recovery, explicit
   no-decrypt exception register, and client trust distribution. Refuse to
   weaken upstream verification to make inspection appear to work.
7. **Runtime status and events.** Worker heartbeats, effective-rule/reason
   display data, last-known-good behaviour during controller outage,
   correlation of DNS/proxy/agent events without tripling visit counts.
8. **Network UI and platform-specific work (deferred).** Explicit scope guard
   and API/demo overrides, not role-only navigation; mobile platform
   capabilities and entitlements after API feasibility tests. UX is likely to
   be wired separately and is not a blocker for backend steps.

## Concrete contracts

All records are owned by `family-policy/src/model.rs`; identities are UUIDs
and timestamps are `DateTime<Utc>`.

- **Household** `{id, name, timezone}`. One household first; no global record
  access. `timezone` is an IANA name (e.g. `Australia/Sydney`).
- **Person** `{id, household_id, display_name, login_links[]}` — stable identity
  with external login links; a login link is not proof of current device user.
- **Device** `{id, household_id, label, kind, shared, default_profile,
  capabilities[]}` — `kind` includes `PersonalComputer | Tablet | Tv | Phone |
  Iot`; `shared` makes unknown identity explicit.
- **Assignment** `{id, person_id, device_id, role, active}` — many-to-many with
  `Owner | Administrator | Member`. Ownership is not current activity.
- **Session** `{id, device_id, verified_person: Option<PersonId>, source,
  assurance, started_at, expires_at, revoked}`. `None` is a first-class state.
  `Assurance::Asserted` and `ParentAssertion` never select person rules; only
  `Verified` OS/proxy/mobile evidence with an active assignment does.
- **Connection** `{id, device_id, kind (Agent|Dns|Proxy|Mobile),
  enrolled_identity, capabilities[], last_seen, status}` — several may be
  active for one device. DNS is a connection, **not** a persistent
  authenticated session. Heartbeat TTL drives `Online`/`Offline`.
- **Policy** `{household_id, revision, baseline[], device_profiles{},
  person_rules{}, exceptions[], default_effect, timezone, stale_after_secs,
  event_retention_secs, published_at}` — complete versioned snapshot.
  `event_retention_secs` must be 1..=2,592,000 (30d); the server's
  `0 = unlimited` convention is rejected.
- **Decision/Event**: decision carries `allow`, `reason_code`, `explanation`,
  `policy_revision`, `applied_rule`, `source`, `effective_identity`,
  per-capability `enforcement`, `evaluated_at`. Event adds source
  (`Agent|Dns|Proxy`), `person_id: Option`, evidence quality and
  `correlation_id` so three sources describing one action are not counted as
  three visits.
- **GatewayCredential** `{id, household_id, gateway_id, secret_hash, issued_at,
  expires_at, revoked_at, allowed_commands[]}` — a **separate** credential
  family with `FetchPolicy|ReportDecision|AckPolicy|ReportHealth`. It is never
  `agents.api_token_hash`, an enrollment claim/invite, or a module report, and
  network enrollment must never call the existing agent `policy_push`.

### Precedence, defaults, outage, expiry, concurrency, timezone, authz

1. Non-overridable household safety baseline (deny only) — final.
2. Valid scoped exception — requires authenticated approver, exact
   device/action or person scope, hard expiry, return path.
3. Verified person rules — only with active verified session and assignment.
4. Device default profile — the path for shared TVs/tablets and unknown users.
5. Household default effect (`Deny` in the examples).
   Within any layer, a matching **deny beats allow**, so adding an allow rule
   cannot accidentally become "most permissive wins".

- Unknown/shared identity is explicit: `EffectiveIdentity::Unknown` or
  `SharedDevice`; no registration owner is fabricated for a TV.
- Expired/revoked sessions and exceptions are ignored at evaluation time;
  the device default returns automatically (tested with a 30-minute exception).
- Stale effective snapshot (older than `stale_after_secs`) fails closed for new
  allows while last-known-good denies remain.
- `PolicyStore::effective_policy()` is controller-side evidence: the last
  snapshot acknowledged by a scoped gateway credential with a passing
  placeholder canary. Durable worker-local last-known-good persistence during
  an ack outage is a separate future requirement, not implemented here.
- Current and applied snapshots share ONE state lock. `publish`, `ack` and
  `rollback` are single atomic transitions: a concurrent newer publish cannot
  be clobbered by an older ack, and an ack validates the credential against the
  exact snapshot it applies. Concurrent readers observed `applied.revision <=
  current.policy.revision` at all times, and equality whenever status was
  `Applied`. Revision overflow is rejected, never wrapped.
- Schedules evaluate in an explicit IANA timezone. At a fall-back fold the
  window START resolves to its first occurrence and the END to its last
  occurrence, so both wall-clock passes are covered — the restrictive choice
  for deny rules and no accidental permissive hour. A spring-forward
  nonexistent time shifts to the first existing minute (up to 3h), which can
  collapse a window to zero length. An invalid timezone makes the schedule
  inactive. Tests cover both fold instants, the gap and an invalid timezone.
- Authz boundaries: the existing server's `RequireOperator` includes `admin`
  and already grants broad remote/Recall privileges. `NetworkAdmin` and
  `NetworkEvents` are **new independent grants**; `AuthUser` currently holds
  only a role string, no scopes. Dashboard actors carry an explicit household
  so a grant in one household cannot publish, read events or ingest into
  another. A UI save is `Proposed` and is not effective until the **expected
  worker** acknowledges with a passing canary flag. Wrong worker, stale
  revision and failed canary are rejected. Rollback creates a **new monotonic
  revision** carrying prior content and is itself propose-only. Event reads
  require `NetworkEvents` (or `NetworkAdmin`); ingestion requires a separate
  `ReportDecision` gateway credential. UI must add an explicit scope guard and
  API/demo overrides, not only role-based navigation.
- No gateway secret is authenticated yet: `secret_hash` is a model field only;
  `GatewayCredential` is checked for scope, household, worker binding, expiry
  and revocation, not for proof of possession. `canary_ok` is a placeholder
  boolean, not runtime verification. Both require real server-side auth and a
  defined canary in later steps. `expected_worker` is the worker identity on
  the proposal; `GatewayCredential.gateway_id` must match it exactly.
- Event records are pruned by the effective retention on ingest. A hard event
  count cap and audit-log linkage are a later slice.

### Worked examples

- **Shared Windows PC**: family default blocks a social domain. A verified OS
  session mapped to a parent applies parent rules and allows it; an asserted
  profile selection does not. Fast user switching/concurrent sessions remain
  an explicit future case.
- **Shared tablet**: no verified user; an authenticated parent exception
  allows one action for 30 minutes, then the family default returns. It does
  not permanently reassign the tablet.
- **TV / unknown person**: `shared = true`, no session; `SharedDevice`
  identity, household TV profile, no named viewer, `DecryptableHttps`
  reported `Unsupported` (no CA) and DNS `Enforced` when the DNS connection is
  online. A TV is not placed on an unrestricted IoT route to solve an app.
- **Personal phone**: assigned person and enrolled mobile identity are
  recorded separately from verified activity and away-from-home coverage.

### Backend API contracts for a future UI

The worker-facing API must expose: inventory of devices with per-connection
status and capabilities (`Enforced | Unsupported | BypassedByPolicy | Offline |
Unknown` — never a stale Protected badge), policy revision/status
(`Proposed | Applied | RolledBack`), effective rule + reason, decision/event
pagination with bounded retention, exception create/revoke with expiry, and
gateway credential enrollment/revocation. Authz is by the independent grants
above, not by remote-desktop or Recall consent.

## Native DNS backend capability checklist

Full native DNS behaviour is **not** claimed in step 1; only Hickory local
zone and forwarding primitives are exercised. Later backend slices must
explicitly account for, and report the disposition of, at minimum:

- UDP/TCP authoritative and forwarding resolution, A/AAAA/CNAME, TTL and
  negative caching, local/split DNS, upstream failover and cache behaviour.
- Filter syntax, allow/deny list subscription and update, block-page and
  sinkhole responses, and per-client/group rule application.
- Encrypted DNS (DoT/DoH/DoQ) as client and upstream paths.
- Optional future read-only router lease enrichment as weak device evidence;
  no DHCP server, lease allocation or router configuration management.
- Query logs, bounded retention, and status during controller/upstream outage.
- Client configuration and enrollment, including what is asserted versus
  verified.

No prototype may bind the live household resolver address, and no
router/DHCP configuration may be changed from this work. Auth, client config
formats and rule syntax must fit Vantyr's existing scope/OIDC model; no
external product's auth or config format is a requirement.

## Honest capability statements

- **HTTP/2**: not implemented or verified in this spike. Hudsucker's `http2`
  feature was left off; source shows it only adds `h2` ALPN and upstream h2
  while its default server builder is HTTP/1.1-only. Rama HTTP/2 client/server
  support is untested here.
- **WebSocket**: no support claimed. It is explicitly out of scope for step 1
  and must be denied or separately accepted in a later slice.
- **TLS MITM / upstream certificate validation**: **open gap**. Step 1 proves
  CA uniqueness/custody shape and destination validation only. There is no
  TLS-terminating proxy test, no bad-certificate/bad-hostname egress test, and
  no fake certificate test may be substituted with DNS rejection. The CA
  signing key must stay in the inspection component; only public certs go to
  enrolled clients. No upstream verification bypass, no shared embedded CA,
  no host network listeners.
- The Rama proof is **service-level** (`EagerHttpProxyConnector` through
  `UpgradeLayer` with a validating connector), not a bound network proxy
  listener. Egress uses an in-memory duplex pair, not a real socket to an
  origin. Binding a loopback listener, real relay, and full policy handler are
  step 5 work.

## Review evidence

- The operations/security runbook and the backend capability checklist were
  independently accepted after their review blockers were corrected. Their
  behaviour scope is retained above in neutral terms.
- An independent review of the step-1 snapshot requested a bounded correction:
  rollback self-applied (C1), ack accepted a dashboard actor string as a worker
  (C2), the DNS sinkhole test claimed policy wiring it did not do (D1),
  controller ack state was described as worker-local LKG (D2), and fall-back
  fold semantics were underspecified (D3). All five were fixed with
  adversarial tests.
- A second review required atomic policy state transitions (one lock), household
  scoping for actors/events, explicit revision overflow handling, and precise
  fold/gap semantics. Those are covered by the concurrency, household-isolation
  and overflow tests in this increment.

## Unresolved issues

1. Define the real canary protocol; `canary_ok` is a placeholder boolean and
   must never be presented as actual runtime verification.
2. Confirm the `GatewayCredential` command set and whether ack must be signed
   per worker or per gateway instance.
3. Integrate accepted worker-local policy persistence into DNS and the
   authenticated policy-distribution path, including lost-ack recovery.
4. Decide the rcgen leaf-issuer design for Rama 0.4 MITM and add a real
   upstream certificate/hostname rejection test.
5. Define concurrent-session handling for fast user switching on shared PCs.
6. Agree retention defaults and audit-log linkage; the accepted operations
   runbook is not duplicated here.
7. The runnable DNS executable is integrated with the isolated lab and its
   full-stack smoke has independent acceptance. Configuration reload, runtime
   acknowledgments and durable restart recovery remain to be integrated.
8. Integrate the accepted bounded runtime queue with DNS and control-plane
   event ingestion; no unbounded event buffers.

No substantive UI or Supabase changes were made in this step.

## Backend integration checkpoints

- Accepted: household-scoped inventory and audit API, shared-device DNS
  connections without a person, and explicit network grants. Independent
  review exercised ten database-backed tests and legacy migration fixtures.
- Accepted: process-restart policy persistence and bounded event queue,
  including expiry of delayed events at every queue position; 22 tests pass.
- Accepted: runnable filtering DNS and isolated full-stack lab. Lab smoke
  exercises actual worker answers, restrictive unknown clients, aliases,
  upstream outage, cache behavior, recovery and same-config restart. This
  does not establish durable worker recovery or controller verification.
- Accepted: scoped gateway credentials and authenticated heartbeat; independent
  review passed 22 gateway tests and all 35 network tests, including concurrent
  ingestion, rotation, revocation and issuance. Report retention defaults to
  seven days and 1,000 records per gateway, with hard limits and periodic pruning.
  Worker-reported revisions remain unverified and unenforced; no real policy
  distribution or canary is delivered by this increment.
- Accepted: authenticated HTTP/CONNECT worker with destination filtering,
  streamed-body and socket progress budgets, and graceful shutdown. Independent
  review passed 36 tests and additional slow-client, keepalive and backpressure
  probes. These are idle/progress budgets rather than a total transfer time
  limit. Static bootstrap credentials remain separate from controller
  enrollment. Optional inspection is covered by the separate accepted increment
  below.
- Accepted: unique inspection CA generation, encrypted key custody,
  memory-only signer unlock, public certificate export and validation tests;
  23 tests include a real TLS handshake and certificate rejection paths.
  Temporary plaintext buffer erasure and recovered certificate/key metadata
  consistency remain explicit hardening limitations. Client trust setup and
  live inspection are separate capabilities; inspection now has independent
  acceptance as described below, while client trust setup remains unfinished.
- Accepted: one complete validated DNS configuration and policy bundle is
  persisted atomically and reloaded as a whole snapshot, preserving revision
  and policy age across restart. Independent review passed 34 DNS tests,
  23 runtime tests and six malformed-state/timestamp probes. Invalid payloads
  are checked before identity access; config/policy divergence and publication
  times beyond 60 seconds of clock skew are rejected. Container-lab coverage of
  durable recovery and reload has now passed the separate review below.
- BYOD enrollment and reversible client setup follow the responsibility
  boundaries in [network-onboarding.md](network-onboarding.md). Router DHCP
  stays outside Vantyr. Frontend implementation is managed independently.

### Integration acceptance and remaining local corrections

- UniFi adapter and setup planner: official versioned API discovery, verified
  HTTPS, bounded reads, topology-aware DNS previews and simulated rollback.
  Review requested transport-level site allowlisting, the documented 200-item
  page maximum and removal of an ineffective hostname builder method. Those
  corrections passed independent acceptance with 24 tests, including zero
  network contact for denied direct transport calls. A further literal-IPv6
  parser correction passed fresh review with 25 tests. No live write path exists.

- Versioned policy control API: immutable saved revisions, monotonic historical
  rollback, desired gateway assignment and explicitly scoped worker retrieval.
  Implementation reports 46 network tests passing. This serves typed policy;
  DNS bundle delivery, application receipts and verification remain unfinished.
  Review found rollback provenance could indefinitely pin source payloads;
  the correction retains revision metadata without extending payload retention,
  adds a rollback serialization-size check and tests 40 consecutive rollbacks.
  Fresh independent review accepted the correction, including an adversarial
  rollback-chain probe and near-64-KiB serialization boundary checks.
- Optional HTTPS inspection: unique signer, upstream TLS validation before
  CONNECT acknowledgment, authority-bound downstream TLS, scoped expiring raw
  exceptions and bounded streams. Implementation reports 53 proxy tests passing.
  Independent security review accepted 53 proxy tests, 23 PKI tests and six
  additional authority/SNI/ALPN probes. Client trust setup is not delivered.
  Local follow-up bounds opaque exceptions to seven days, corrects CLI help
  and allows explicitly approved remote ports 80/443 while keeping the listener
  unprivileged. Fresh review accepted these follow-ups with 55 proxy tests,
  25 UniFi tests and clean scoped clippy checks.
- Durable container lab: implementation reports base/full-stack/durable smoke
  passing, including higher-revision reload, invalid reload preservation,
  restart with a changed external config and preserved stale-policy behavior.
  Fresh independent review accepted the parse-specific corrupt-state assertion,
  fresh timestamp fixtures and all 25 durable-smoke assertions. Both positive
  and negative diagnostic controls passed; all scoped containers, networks and
  volumes were confirmed removed.
  Local-list lab update `e0854b93` is independently accepted against frozen
  worker source `c21da216`: real UDP/TCP list/service/alias checks, baseline
  precedence, invalid-candidate disk-hash preservation, abrupt-restart material
  recovery and explicit disable/removal all pass. The runtime carries parser
  attribution notices; all four guarded projects had zero containers, networks
  and volumes after cleanup. Maintenance `6621f897` + `bfc44fef` is independently
  accepted against frozen `39c467e9`: the restricted build includes the required
  subscription crate, and exact labelled policy/bundle/filter counter checks pass
  durable and list smokes, including negative prefix-mismatch probes. No
  `--subscriptions` runtime is enabled in those fixtures; this evidence does not
  accept the pending automatic-fetch lifecycle implementation.
- Parent integration check: server and proxy compile together with the committed
  dependency graph using `cargo check --locked --offline`. No deployment follows
  from a successful build or a pushed feature-branch commit.

### Accepted management contract correction

- Nullable inventory PATCH fields now distinguish omission (keep), JSON null
  (clear) and a valid value (set). Commits `08f191ba` + `e18524fb` are independently
  accepted: 67 network tests, including the real HTTP/database revoked-at clear
  regression, plus strict scoped clippy and focused authorization probes pass.
  The frontend has been sent the accepted contract. Clearing reported connection
  metadata never reinstates a revoked worker credential or proves enforcement.

### Active implementation tracks

- Management reads: `4143aa3d` plus correction `b3cf8078` are independently
  accepted. Policy body/current reads and semantic diff, filtered audit
  totals/pagination, own enrollment contexts and scoped display labels have
  12 targeted tests and strict clippy passing. Diff scopes distinguish
  safety baseline from device profiles, including a profile named baseline;
  empty-profile changes are reported. Pagination explicitly marks records
  beyond the offset cap instead of advertising an invalid next page. The
  frontend has received the accepted routes, DTOs and permission table.
- Controller-driven DNS: bounded authenticated HTTPS retrieval, compatibility
  checks and application through the accepted durable bundle/reload path.
  Commits `83c7bce3` and `567f1e0e` are independently accepted with all 48 DNS
  tests passing. Local and controller updates serialize basis capture through
  persistence/publication; controller pulls preserve the current local zones,
  device mappings, denial mode and upstreams, including across restart. Scope,
  schema, revision, publication time and content digest are validated; unsupported
  policy shapes are rejected before application.
  Application acknowledgments and independent coverage verification remain
  separate subsequent integration steps.
- BYOD backend: commits `3afcb9fc` and `db942852` independently accepted
  with 66 network tests. Scoped SSO principal bindings, single-use setup grants
  and time-bounded session receipts include locked permission rechecks, atomic
  logout revocation and production age/count retention sweeps. The live
  enrollment cap is 100 per household, not a lifetime inventory cap. Client trust,
  endpoint monitoring and worker/client identity integration remain subsequent work.
- Filtering lists: library commit `2e59e1e0` independently accepted with 11
  real-backend tests and adversarial syntax, service and precedence probes.
  Immutable maintained-parser adapters provide bounded list input and explicit
  supported-rule semantics, plus bounded named service/domain groups. Local-file
  worker integration `c21da216` is independently accepted with 99 DNS/filter/runtime
  tests. Validated bytes and derivation metadata persist in the one bundle;
  real UDP/TCP list/service/alias checks and restart with changed or missing
  source files pass. Accepted scheduled integration now separates bundle/material
  generations from controller policy revisions.
  Service blocking is DNS-domain coverage, not proof of application identity or
  every feature hosted on a shared CDN.
- Public list subscriptions: library commits `f52d069e`, `f2b5805c` and
  `6196d6d8` independently accepted with 22 tests. Production disables implicit
  system/environment proxies; restored bytes are revalidated by the current
  compiler callback. Aggregate limits serialize promotion and count raw bytes.
  Operator-configured HTTPS URLs (including raw GitHub files), per-list refresh
  intervals, manual refresh, conditional requests,
  bounded retries/backoff and atomic last-good caches. Failed downloads or parse
  failures must not discard working filtering data. Freshness, update errors and
  disabled lists remain visible separately from enforcement. Parser, fetcher and
  worker integration each require independent acceptance.
  Scheduled worker integration `39c467e9` + `7027b7da` is independently
  accepted. Fresh review ran all 83 DNS tests, 48 affected runtime/subscription
  tests and focused production-loop, first-boot, cache-quarantine, migration and
  real-binary SIGINT checks. The one canonical server Arc keeps the integrator
  alive; generation checks reject stale preparation; manual requests retain
  per-source scope; shutdown aborts and awaits the task. Valid bundles recover
  independently of faulty caches, while clean installs fetch before first bind
  and fail closed if required material is missing. Policy publication age and
  revision remain separate from bundle/filter generations. Downloaded versus
  applied status is distinct, but currently library/CLI only: dashboard HTTP
  management and an isolated scheduled-fetch lab remain subsequent work.
- Management mutations: commits `8a665f08` + `daf96446` independently accepted.
  Household name/timezone and gateway label/enabled PATCH, conservative inventory
  DELETE and atomic person default-profile selection are ready for the UI.
  Both independent review and parent checks passed six mutation tests and strict
  scoped clippy. The concurrent create/delete regression observes a real HTTP
  insert's FK lock wait, commits the deletion and receives 409 without leaking
  constraint details; assignment/connection create and PATCH share the mapping.
  Retained enrollment/binding references block deletion even when ended/revoked;
  gateway re-enable never revives a revoked gateway or credential. Exact accepted
  routes, DTOs, permission rules and limitations have been sent to the frontend.
- Dashboard DNS management is in progress as a separate control-plane slice:
  versioned desired list/service settings, scoped outbound worker retrieval,
  bounded download/local-apply reports and per-gateway refresh acknowledgments.
  Policy history and its publication age remain independent. The worker consumer
  and end-to-end acceptance are required before dashboard controls are presented
  as functional. Existing cache/rate/retention and coverage placeholders remain
  pending; accepting list configuration does not implement those capabilities.
  Server control-plane commits `a8b5b994` + `eadf36d4` are independently accepted
  with 19 targeted tests and strict scoped clippy passing. Independent database
  probes confirmed 40 concurrent inserts admit exactly 32 requests without
  deadlock; updates at the cap and destination-household move checks pass.
  Desired configuration, scoped worker read/report commands, bounded delivery
  evidence and per-gateway refresh acknowledgments are implemented. The worker
  consumer is being built against that committed wire contract. No dashboard
  handoff or end-to-end acceptance is claimed yet.
  Initial review found repeated refresh receipts stayed stuck on the old token
  and timestamp windows rejected valid seven-day scheduling or old applied
  content. Parent fix `eadf36d4` passes 19 targeted tests and strict scoped
  clippy and fresh independent acceptance. It also returns stored token
  version/expiry on deduplication, prevents false historical delivery evidence,
  pins the latest status's delivered version, bounds numeric casts and corrects
  the database request cap with additive migration 0080 (0079 unchanged).
  Worker consumer commit `4f47d6d0` is under independent review. The implementer
  reports 159 affected tests, including eight real-TLS management tests, and
  clean scoped clippy with no dependency changes. Review checks the actual
  client/coordinator lifecycle, current-local-state races, automatic refresh
  after initial apply, failed-candidate isolation and server report compatibility.
  Follow-up `590aacc1` adds coordinator-loop, current-token and unchanged-age
  coverage plus an enabled-only fetch correction; the implementer reports 162
  affected tests. These additions are included as context for the active review.
  Worker review rejected this slice: a missing refresh-expiry field rejects real
  server responses, automatic list refresh can discard managed state, delayed
  preparation can restore stale local material, failed candidates replace active
  fetchers, receipt reporting exceeds the server contract, and management version
  rollback/conflict checks are missing. Substantive fixes and fresh independent
  review are required. It is not accepted or ready for dashboard handoff.
  Fix `8277aefd` is under fresh review. The implementer reports 170 affected
  tests and no dependency changes; the fix unifies applied management/material
  authority, stages fetchers, guards the preparation basis, bounds receipts and
  checks management versions. A separate real-server/worker test harness is being
  built to exercise status admission against the migrated PostgreSQL-backed
  router; shared wire fixtures alone do not establish that end-to-end result.
  Fresh review accepts the six original fixes and confirms real server DTO/status
  validator parity. Integration handoff remains blocked on two residual gaps:
  rebuilding managed fetchers after restart (including real subsequent download,
  not an acknowledgment without work), and reporting only the bounded desired
  management source scope. These are required lifecycle behavior even though the
  reviewer classified them as unchanged limitations. A separate fix and real
  server/worker restart-refresh test are in progress. Test-harness dependency
  inspection confirms only server dev-dependency edges change, with no new
  registry package, version or checksum drift.
- Verified encrypted upstreams (DoT/DoH), commit `d59e99e1`, are independently
  accepted separately from encrypted inbound listeners. Fresh review passed all
  91 DNS tests, including eight real-TLS upstream tests, and strict clippy.
  Literal bootstrap addresses, normal certificate verification, bounded explicit
  CA material and no implicit plaintext/system fallback are confirmed. All
  operator CA entries form a shared trust pool across encrypted endpoints;
  per-endpoint CA isolation is not provided and the README states this limit.
  Lock inspection confirms only `h2 0.4.21` is newly added, with no existing
  version/checksum changes. DoQ/H3/DNSCrypt, routing, fallback and encrypted
  inbound listeners remain separate open requirements.
