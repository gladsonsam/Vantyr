# Network continuation — environment handoff

## Current priority and candidate boundaries

Dependency policy: prefer actively maintained crates for DNS transports,
cryptography, parsing, matching and other standard behavior. Keep Vantyr-owned
code focused on policy, authorization, persistence and thin integration layers.
Evaluate maintained library coverage before writing a replacement subsystem;
do not translate or vendor another implementation merely to recreate behavior
already supplied by a suitable Rust crate. Minimize long-term custom code and
duplicate dependency stacks, rather than maximizing dependency count. Preserve
focused behavior tests across dependency updates so an upgrade can be reviewed
without rebuilding confidence manually. Dependency updates still require
periodic review and validation; they do not eliminate operational maintenance.

Active maintenance is an adoption requirement, including for existing core
dependencies when revisited. Verify upstream repository status, meaningful
development/release activity, maintainer responsiveness, security support and
maintenance of critical transitive dependencies. Popularity, a recent initial
release or an old stable version alone is insufficient evidence. Do not adopt
archived, abandoned or unsupported crates for required runtime behavior. If a
current dependency fails this check, record the gap and evaluate a maintained
replacement before expanding reliance on it. No project can guarantee future
updates; keep adapters and regression tests suitable for dependency replacement.

Initial upstream activity check (2026-11-27): the GitHub repositories for
Hickory DNS, rustls, the maintained adblock engine, regex and ipnet are neither
archived nor disabled. Their latest default-branch commits were dated
November 26, November 26, November 24, November 18 and September 6 respectively.
The crates.io APIs also show recent publication of the pinned Hickory 0.26.4,
adblock 0.13.6, regex 1.13.2 and ipnet 2.12.2; rustls has continuing stable and
development release activity. Sources: each upstream repository's GitHub API
and `https://crates.io/api/v1/crates/<crate>`. This is activity/publication
evidence only, not a completed security-support or transitive-dependency audit;
no dependency versions were changed by the check.

DNS replacement readiness takes priority over proxy work. Required DNS breadth
includes filtering syntax/modifiers, rewrites, per-client controls, SafeSearch,
and encrypted client and upstream transports. Partial slices do not close those
capability rows. Operator configuration, HTTP delivery, frontend controls,
recovery and real query behavior each need evidence before household cutover.
Proxy authority remains unaccepted and its diagnostic work is deferred.

Pending Hermes slices are isolated from the integrated branch:

| Source checkpoint | Scope | Evidence / remaining gate |
|---|---|---|
| `497a541d` | Desired-only migration 0086 | Independently accepted in its bounded scope; two real-PG tests pass. Depends on unaccepted DNS contract upgrade; not integrated. |
| `cca53f6b` | Explicit pre-0085 evidence snapshot/restore scripts | Independently accepted with real-schema PostgreSQL tests, including empty snapshot, corruption and rollback cases; combined upgrade E2E remains pending. |
| `2e927fc7` | Explicit offline worker-bundle converter | Independently accepted in bounded scope: five focused tests pass and CLI compiles. Full upgrade E2E remains pending; not integrated. |

All runtime validation remains serialized by the shared Rust lock. No new
frontend contract is accepted by these pending slices. Keep correspondence
batched around actionable findings and exact accepted contracts.

Exact-domain A/AAAA/CNAME operator rewrites are accepted and integrated through
`8dfc813e` (source chain `ea06e556` through `57a8c06b`). Independent review and
tests cover denial-before-rewrite, canonical-target denial, UDP/TCP answers,
reload and restart persistence. The first crate run recorded 133 passes and one
new evaluation-log assertion failure; after test-only corrections, the four
remaining/rechecked targets passed 31 tests. The final equivalent `matches!`
selection passed strict crate all-target clippy. This is scoped cumulative
evidence, not a single final whole-workspace pass. Filter-text rewrites,
wildcards, suppression forms, broader RR types, HTTP and UI remain unfinished.

CIDR source-to-device selection is accepted and integrated through `3d5312c8`
(source `55afc67c` + `ca2554d8`). Exact IPs take priority, then longest-prefix
ranges; unknown sources retain the restrictive default and no person identity
is inferred. Independent review recorded 142 passing tests and one new source
presentation assertion failure; after a test-only canonical-IP correction, all
34 tests in the remaining/rechecked targets passed, followed by strict crate
all-target clippy. Tags, per-client upstreams, broader identity sources, HTTP
and UI controls remain unfinished.

Bounded hostname regex filtering is accepted and integrated through `02753b27`
(source chain `cedc2148`, `68698662`, `075d8c41`, `f176720a`). Independent
review verified deterministic important-domain-exception handling and ASCII
IDN canonicalization; 25 focused compiler tests pass. Parent mechanical lint
corrections passed strict compiler-crate all-target clippy and the build without
default features. Thirteen real worker filter tests pass on the integrated
tree, including UDP/TCP regex and exception enforcement, truthful rule evidence,
household/unknown-device denies, IDNs and restart from unchanged persisted list
bytes despite a modified source file. Aggregate rule/work/reservation budgets
reject oversized candidates; reservation accounting is not a process RSS bound.
Important regex exceptions and broader context modifiers remain unfinished.

The first global SafeSearch operator slice is accepted through `8c45f8cd`
(source `45965f8e` plus test corrections): eight real loopback integration tests,
six library tests and strict crate all-target clippy pass. Supported names are
only `www.google.com`, `www.google.co.uk`, `www.bing.com` and
`edgeservices.bing.com`; provider targets are resolved through the existing
Hickory resolver with question and target denials preserved. This does not
cover `www.google.com.au`, other Google region domains, YouTube restricted mode,
per-client overrides or HTTP/UI settings. Those remain required unfinished work.
After integration with hostname regex and CIDR selection, the parent reran the
13 worker filter tests and eight SafeSearch integration tests: all 21 passed.

The explicit DNS-over-TLS operator listener is accepted through `1dfceace`
(source `1815fecb`, `3c23c106`, `dc591268`). Nine listener tests and strict
crate all-target clippy pass. TLS material for the actually selected config is
validated once before fresh durable persistence or socket binding; protected
file reads use no-follow and descriptor checks. Client CA/hostname verification,
policy/flags, invalid-custody startup, persisted restart, CIDR behavior and
shutdown are tested. After integration with regex, CIDR and SafeSearch, all
39 targeted listener/upstream/filter/SafeSearch tests passed. The two integration
conflicts combined export lists and retained both adjacent controller-preservation
tests; no runtime feature was dropped. Atomic certificate rotation, other
encrypted server transports, HTTP/UI and household deployment remain open.
Independent dependency review found active upstream work for the newly direct
`x509-parser 0.18.1`; formal security-support evidence remains incomplete.

Google regional SafeSearch is accepted through `0f10b1d9` (source `b96c3583`).
The catalog matches all 187 exact www owners from Google's official supported
domains list retrieved 2026-11-27, including AU/NZ, with no wildcard or lookalike
matching. Independent review verified the live-source comparison; ten loopback
integration tests, nine library tests and strict clippy pass. This supersedes
the earlier four-domain limitation above. The catalog is a reviewed snapshot,
not a live feed. Bing is unchanged.

YouTube restricted modes are accepted through `f8c4ada8` (source `addd858f`).
The optional mode defaults off; moderate and strict select the five exact
official aliases and their respective hostname targets. The master SafeSearch
switch gates all providers, while Google, Bing and YouTube choices remain
independent. Excluded hosts and canonical targets are never rewritten.
Independent review passed 18 loopback integration tests, 12 filtered library
tests and strict crate all-target clippy. Per-client overrides and HTTP/UI
settings remain unfinished; this acceptance covers operator configuration only.

The assembled current-contract upgrade candidate is `aa2126c2`, based on
`705d99f2`; it includes the reviewed 0086 repair, evidence scripts and offline
converter while preserving strict persistence cleanup and exact rewrites.
It is not integrated or accepted: combined server/worker settings, cache-clear
lifecycle and upgrade/restart validation are still required.

## Hermes resumption checkpoint (2026-11-27)

The prepared continuation branch started clean at `a722484b`. All six remote
checkpoints below were fetched and matched the handoff. The requested OpenCode
`opencode-go/hy4-flash-free` model with `variant: high` is available.

Policy report gate source `f30f0e04` passed a fresh independent static review
and is integrated as `81acec87`. Its six-file scope removes the historical
module-report bypass without changing the wire contract. The earlier 11 real-PG
module tests remain the runtime evidence; no new Hermes test pass is claimed.
First-report policy re-push is supported by source inspection but lacks focused
integration coverage. The removed query's orphan SQLx cache entry remains for
later verified cleanup.

DNS settings and proxy authority candidates remain unaccepted. The first Hermes
proxy confirmation ran zero tests: offline dependency resolution lacked locked
`anyhow 1.0.105`. A fresh bounded confirmation permits dependency downloads while
retaining `--locked`, offline SQLx metadata and the global Rust validation lock.
This is not evidence that the positive HTTP fixture fix works.

The frontend partner now works on Hermes in `feat/network-ui-hermes`, starting
at `415431a3`. The old frontend environment remains frozen. New DNS settings and
proxy controls remain demo-only until exact accepted contracts are supplied.

Fresh static review of DNS candidate `32ab0ada` blocks acceptance. Migration
0085 changes a formerly schema-1 body's digest at the same config version;
an already-applied worker rejects that equal-version/different-digest pair.
Previous persisted management shapes also need an explicit offline conversion,
not a runtime compatibility reader. Appending default runtime can exceed the
existing 16 KiB body constraint. Seeded migration tests and an upgrade test with
a pre-existing applied bundle are missing. Repair design is pending; no database
migration or DNS candidate integration has been performed on Hermes.

Strict persistence cleanup source `adf4092a` passed fresh independent review,
24 `vantyr-network-runtime` tests and five DNS `generation_migration` tests on
Hermes, with each complete command under the shared Rust validation lock.
It removes `Persistable::normalize`, missing-counter repair and unused
policy-only persistence aliases. Current counters, high-water checks, private
atomic persistence and last-known-good behavior remain. Rejected missing-counter
bundles leave disk bytes unchanged. No full DNS/workspace/clippy or database
validation is claimed by this focused acceptance.

## Stop state

The user requested that the current small agent jobs finish, then work stop for
an environment move. They have finished. No new implementation or reviews were
started after that request. No PR, main merge or backend/household deployment
was performed by this thread. The backend working tree is clean after this
handoff commit. All references below are pushed to `origin` in
`https://github.com/gladsonsam/Vantyr`.

## Refs to fetch

| Remote branch | Source checkpoint | Status |
|---|---|---|
| `feat/family-network-gateway` | `7da6193c9e92c0d80ee3ad0919d5fde09467a9d4`, plus this documentation-only handoff | Integrated backend baseline; remaining roadmap is not complete |
| `feat/network-ui` | `415431a3afe744753da29ede804edc9c4071aec5` | Frontend committed/pushed; typecheck/lint pass; real-server UI untested |
| `checkpoint/network-dns-current-contract` | `32ab0adaf8596722ce72867de33e28b7c1ab82cd` | Candidate only; current-contract DTO tests pass; DB/E2E review pending |
| `checkpoint/network-policy-report-gate` | `f30f0e04c829464f4d70ca74fb42152c2ee39621` | Candidate only; 11 module tests pass; independent review pending |
| `checkpoint/network-proxy-authority` | `e1fd70b6971e9ee8af72e79aa732b5afa0271305` | NOT accepted; confirmation of the fixture fix did not finish |
| `checkpoint/network-strict-protocol-wip` | `1031342f8e5e0bc7a960edc7040347d0622aa473` | Saved WIP only; no completed validation/acceptance claim |

Fetch before reading or cherry-picking candidates. The candidates have different
bases; do not blindly merge all branches or replace the integrated baseline.
Keep candidate changes separate until reviewed. Original worktree paths are
machine-local and are not needed to retrieve these pushed commits.

## User requirements that must carry forward

- Pre-release application: ONE current contract. Remove old/new DTO dispatch,
  legacy readers, compatibility-only aliases and obsolete routes. Explicit,
  coherent data migrations are allowed. Do not confuse policy revision history,
  CAS configuration versions, generation counters or migration checksums with
  legacy protocol support.
- Use fresh, disposable subagents for small bounded jobs. One concrete output,
  one concise handoff; do not keep extending the same agent for hours. Split
  saved large patches into reviewable tasks. Use fresh agents for follow-ons
  and reviews. Small review fixes may be made by the orchestrator.
- Requested delegated model: provider `opencode`, model
  `opencode-go/hy4-flash-free`, option `variant: high`. The plain
  `opencode/hy4-flash-free` endpoint hit its free quota. Do not switch models
  silently. Observe available runtime concurrency slots.
- Only ONE Rust validation run globally, including builds, tests and clippy.
  On this host all agents used
  `flock /var/tmp/vantyr-rust-validation-gladson.lock cargo ...` for the entire
  command, including test execution. Use one common lock on the next host too;
  do not start duplicate checkers or multiple waiters per agent.
- Frontend tests were intentionally removed. Do not restore/add them. Keep the
  five-device demo, typecheck/lint, honest demo/HTTP/unavailable data sources.
  Do not perform browser work unless requested. Earlier browser validation is
  not evidence for later edits.
- No unasked host DNS, DHCP, router, firewall, trust-store or CA installation;
  no production DB changes, main merge or deployment. No fabricated enforcement,
  protected or verified-coverage signal.
- Keep secrets out of logs/chat/commits. Test PostgreSQL was a dedicated local
  disposable container, not household data. Provision a fresh throwaway DB in
  the new environment; old machine credentials/port are not portable setup.

## Integrated baseline

Detailed evidence is in `docs/family-network-implementation.md`, the granular
`docs/network-dns-capabilities.md`, and `server/docs/network-*.md`.

Implemented/reviewed foundations include household inventory/grants/audit,
BYOD enrollment, immutable policy publication/history/rollback/assignment,
scoped gateway credentials, durable DNS bundles, list/service filtering,
scheduled downloads, verified DoT/DoH upstreams, cache/response-shaping runtime,
and proxy credential/session-evidence library foundations.

DNS events are implemented through real CLI/durable worker reporting and scoped
server logs/statistics. Cache metadata is explicitly unknown; upstream identity
is absent. The queue is volatile and reports loss. Root fixes include root-dot
validation, PostgreSQL-microsecond cursors, inclusive final statistics buckets,
and restoring every pending batch in FIFO order on retry cancellation.

Validation milestones are scoped, not a claim that the latest whole repository
has one unified final test pass:

- Earlier combined server baseline: 422 tests and workspace all-target check.
- Cache runtime independent review: 137 DNS tests, fmt and strict clippy.
- Proxy library independent review: 82 tests plus 10 independent probes.
- Events foundation review: 117 network tests; parent corrections: 11 focused
  tests. Emitter review: full DNS plus 14 server event tests. Parent emitter
  cancellation corrections: nine event unit tests, process test, strict scoped
  DNS/server clippy. All those parent tests passed.
- Credential/config cleanup: server all-target check and native-agent current
  config round-trip/obsolete-key rejection test passed on Linux. Only
  `ADMIN_PASSWORD` is read for server bootstrap; old agent password keys and the
  Linux `config.dat` fallback were removed. No host config files were changed.
- Current DNS event fixture path is `tests/network-contracts/dns-events/`;
  worker/server fixture checks pass after the rename.

## Candidate details and smallest next tasks

### DNS current contract

`32ab0ada` follows `6d88bb3a` (runtime settings/cache-clear implementation) and
collapses its former dual wire into one strict
`ManagementConfig { sources, catalog, selected_services, runtime }` in that
serialization order. `runtime` is required. No `schema_version` or v2 dispatch.
Canonical fixture digest:
`4652ce3244e14658db02de0c05520507d0d92619a434a6a455a8309f5dbb6d37`.
Migration `0085_dns_single_contract.sql` converts stored config bodies/digests.
Current fixtures are `tests/network-contracts/dns-management/`.

Bounded validation: worker DTO tests 4 passed, server DTO tests 23 passed; all
test targets compiled but DB tests were filtered out. No current-contract
DB-backed E2E acceptance is claimed. Review the migration, reset/local-settings
semantics, repeated cache-clear delivery/ack lifecycle, restart behavior and
compatibility removal, then run focused DB/E2E tests. A no-op `reject_schema`
test toggle remains. Old persisted worker shapes are intentionally rejected;
decide/document any explicit offline conversion rather than adding old readers.

This candidate still contains old DNS bundle counter-normalization machinery.
The separate Hermes cleanup source `adf4092a` is now accepted and integrated;
retain it when integrating candidate slices. It removes `Persistable::normalize`,
missing-counter acceptance and dead policy-only persistence aliases while
preserving strict current counters, LKG, private-file and atomic-persistence checks.

### Policy report gate

`f30f0e04` is based directly on `7da6193c`. It removes
`legacy_policy_delivery` and the unused history query. App/network policy
commands now require a validated current module report and normal grants.
Eleven focused real-PG module tests pass; fmt passes. Review independently.
An orphan SQLx cache entry for the removed query may need deletion after a
proper SQLx check. No protocol wire changes are part of this candidate.

### Strict agent protocol WIP

`1031342f` preserves the canceled broad run: 25 files, including strict protocol
types, removal of `lenient.rs`, permission-fence changes and server ingest
adaptations. Base is `c14ad936`; it overlaps the policy-report-gate candidate.
Do not claim it compiles or merge wholesale. Split protocol decoding, command
admission and individual ingest consumers into small fresh-agent jobs. Reuse
the code as saved input, not an accepted implementation. Preserve active
capability negotiation, permission generations, secret redaction and current
optional fields that are genuinely optional.

### Proxy server authority candidate

`e1fd70b6` is based on `b50b18e4`, adds migration `0083`, server credential/
session/evidence APIs, explicit proxy worker introspection and worker authority
integration. Server dev dependencies add exactly one existing `family-proxy`
lock edge; no other lock version/checksum change was reported.

The focused E2E initially passed stale-authority fail-closed but positive HTTP
returned 407. Diagnosis: fixture omitted `shared:false` while server credential
kind was personal. The fixture was fixed and debug prints removed. Confirmation
timed out during rebuild, so THE FIX IS UNVALIDATED. Next task is one focused
confirmation, not more feature work. Then review authorization, revocation,
evidence replay, assignment freshness, TLS and private option custody. No UI
wrappers are accepted for these APIs. Established opaque CONNECT tunnels are
not retroactively closed by credential revocation.

## Frontend continuation

`feat/network-ui` is pushed at `415431a3`, with no frontend-owned uncommitted
changes. Typecheck/lint pass; no frontend tests exist. Accepted backend routes
are wired through DNS events/stats; runtime keys include source/household and
cross-scope placeholders are blocked. The orchestrator inspected the cache-key
fix, but broad real-server UI and browser-flow validation remains pending.

DNS runtime/cache settings and proxy credential/session management remain demo
only until their current backend candidates are accepted. Proxy history/stats,
coverage/canary, Run check and other unsupported controls remain unavailable on
the real source. Preserve unknown device/person and incomplete-history wording.

Open UI checks include Access/Household dialogs, policy editor/diff, enrollment
chooser/scoped pages, activity, list/service edits and credential scope rotation.
No frontend flow has been run against a real server/worker. Remaining cleanup
includes version-labelled localStorage keys, old persisted preferences, some
dead exports and separate Tauri UI tokens; do not delete stored captures/audit
or current demo/runtime behavior just to remove a label.

## Other work not owned by this thread

The original checkout `/home/gladson/dev/personal/Vantyr` contains unrelated
uncommitted changes from other threads: roughly 315 SQLx JSON files, manifests,
agent generated schemas/docs, server docs/configuration and tooling files.
They were NOT committed, reset or copied by this orchestrator or the frontend
worker. They are NOT made portable by the branches above. Retain the old
environment until their owners checkpoint them. Do not blindly stage, stash or
delete them while integrating this work.

## Resume order

1. Fetch these refs and read this document plus the capability catalog.
2. Review/validate candidates separately; integrate only accepted slices.
3. Complete one-current-contract cleanup using small disposable jobs.
4. Send exact accepted routes/DTOs/grants to the frontend and validate real flows.
5. Continue remaining DNS protocol/filter breadth, proxy observability/onboarding,
   independent coverage verification, UniFi integration, packaging and recovery.

No automatic continuation is requested from the old environment. No active Rust
validation processes remained when the handoff was prepared.
