# Vantyr Network — isolated DNS lab

A bounded Docker Compose environment for Vantyr DNS. It runs a deterministic
stub resolver, a real `vantyr-dns` worker process and ISC BIND `dig` clients on
a private internal Docker network. It changes nothing on the host: no host DNS,
DHCP, router, firewall, CA, privileged port, Docker socket mount or production
data is involved.

## Status

**Supported and actually run here:**

- `bash scripts/lab.sh smoke` — the base upstream-only smoke. It is unchanged:
  it verifies the stub's UDP/TCP, AAAA, CNAME, NXDOMAIN and TTL behaviour plus a
  controlled outage and recovery.
- `bash scripts/lab.sh fullstack-smoke` — the opt-in full-stack smoke. It builds
  the accepted `vantyr-dns` worker from source, starts it against the same stub,
  and asserts real filtering, per-source profiles, alias-chain denial, negative
  TTL forwarding, upstream-outage behaviour, same-config restart equivalence,
  and startup rejection of malformed/wildcard configs. It cleans up only its own
  guarded Compose project.
- `bash scripts/lab.sh durable-smoke` — the opt-in durable-bundle smoke. It runs
  the real `--state`/`--worker` worker against a disposable, nonroot-owned state
  volume and asserts SIGHUP reload, rejection of malformed/stale/foreign/
  bind-changing candidates, real recovery after an abrupt kill with a changed
  external config, and stale-age fail-closed across a restart. See below.
- `bash scripts/lab.sh list-smoke` — the opt-in local-list / selected-service
  smoke. It runs the real `--config`/`--state`/`--worker` worker against a
  separate disposable state volume and synthetic operator fixtures, and asserts
  initial UDP/TCP hosts and ABP blocks, list-layer exception limits, selected
  service exact/suffix behaviour, listed-alias denial, higher-revision reload
  of a changed file, rejection of bad/unsupported candidates without touching
  runtime or disk, restart from persisted validated material when the on-disk
  files change or vanish, and explicit disabled/removal. See below.

The list smoke is built from a **read-only `git archive` of accepted commit
`c21da216d7f5cb778014a9ae16da4b9939c43d86`** (the DNS local-list/service commit),
never from a concurrently edited working tree. Only the four accepted crates,
the pinned root `Cargo.lock` and the lab-owned build manifest/notices are placed
in that disposable build input; the root manifest/lock are read-only and no
registry or version is changed. Set `VANTYR_NETLAB_BUILD_CONTEXT` to that input
to reproduce the frozen build; the committed default is the repository root so
the script works normally once dependencies are ready.

The Vantyr DNS worker is a real binary (`crates/family-dns/src/bin/vantyr-dns.rs`)
with its own accepted real-process and socket tests; its validated configuration
schema lives in `crates/family-dns/src/config.rs`. No integration hook template
is needed any more — `compose.vantyr.example.yml` and `compose.vantyr-durable.yml`
are working opt-in overrides.

Not integrated and therefore **not claimed here**: controller acknowledgment/
API/canary, authentication or enrollment, and encrypted DNS (DoT/DoH/DoQ). The
full-stack restart assertion only re-runs the *same process with the same config
file*; it is deliberately not a reload or LKG claim. The durable smoke claims
only unauthenticated **local** persistence across a process restart — no
signature, controller origin, ack or "verified/protected" assertion. DHCP
serving is out of scope and stays on the user's router — this lab neither runs a
DHCP server nor changes routes.

## Verified toolchain and pins

| Component | Pin | Purpose |
|---|---|---|
| Docker Engine / Compose | 29.9.0 / v5.6.0 | runtime used for the recorded runs |
| Stub upstream | `coredns/coredns:1.15.0@sha256:0a9d8c8ddf34347eb59aad9a8784f0710de88d6d112726d11d271f9bc6daca26` | authoritative deterministic zone |
| Client base | `docker.io/library/alpine@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f` (3.22.8) | scratch client host |
| DNS client tool | `bind-tools=9.20.30-r0` (ISC BIND `dig`) | UDP/TCP assertions, no wire parser |
| Rust builder | `docker.io/library/rust:1.99.0-slim-bookworm@sha256:2c3a22f0a5533ea2dd5a16627bc841228151faa2d4de2644ac9987e4a2f1f2fa` | compiles the worker |
| Runtime | `gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f` | nonroot (65532) worker runtime |
| Shell lint | `koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d` | validation only |

Digests were read from the registry tag listings before pinning. The client
image is built locally from the digest-pinned base with a pinned package
version. The worker image build context defaults to the repository root but copies only
`tests/network-lab/build/Cargo.toml`, the root `Cargo.lock`, the four required
crate trees (`family-policy`, `vantyr-network-runtime`, `vantyr-network-filter`,
`family-dns`) and the lab-owned `THIRD_PARTY_NOTICES.md` attribution file.
`vantyr-network-runtime` is needed by the durable worker;
`vantyr-network-filter` is needed since c21 for the bounded hosts/ABP and
service-list compiler, whose MPL-2.0 `adblock-rust` dependency is attributed in
the runtime layer. It never copies `.`, `.git`, `.env*`, `secrets/`, the main
server, the HTTP proxy, the inspection/PKI crates or any production data, and it
introduces no dependency fork or low-level DNS parser. Cargo resolves from the
copied lock inside the image (a lock superset is pruned there, but every pinned
name/version/checksum used by the worker is unchanged). The root Cargo
manifest/lock are only *read*, never edited; build output stays in the image's
own target scope. An operator may set `VANTYR_NETLAB_BUILD_CONTEXT` to a
read-only frozen source input (the exact c21 archive layout) to make a run
reproducible without changing any image, network or security setting. The same
digest-pinned Alpine base is reused by a one-off root helper only to `chown`
the disposable state volume to uid 65532 — the distroless worker has no shell.

## Run the supported checks

From this directory:

```bash
cd tests/network-lab
bash scripts/lab.sh smoke            # base, upstream only
bash scripts/lab.sh fullstack-smoke  # opt-in Vantyr DNS filtering stack
bash scripts/lab.sh durable-smoke    # opt-in durable bundle / reload / recovery
bash scripts/lab.sh list-smoke       # opt-in local lists + selected services
```

`smoke` builds the client, starts the base stack, runs every base assertion,
injects an upstream outage and recovery, then always removes only this Compose
project. A successful run ends with `SMOKE PASS`.

`fullstack-smoke` additionally preflights the project and subnet, builds the
worker image, starts Vantyr DNS and a second client, runs every assertion below,
injects an upstream outage, restarts the worker with the same config, checks
startup failure paths, and always removes only this Compose project. A
successful run ends with:

```text
[vantyr-netlab] PASS: Vantyr sinkholes exact-blocked name
[vantyr-netlab] PASS: Vantyr sinkholes suffix-blocked name
[vantyr-netlab] PASS: local CNAME to denied target is blocked
[vantyr-netlab] PASS: forwarded CNAME to denied target is blocked
[vantyr-netlab] PASS: unknown client uses restrictive profile
[vantyr-netlab] PASS: cached allowed answer during upstream outage
[vantyr-netlab] PASS: configured block holds during upstream outage
[vantyr-netlab] PASS: no failopen during upstream outage (no fallback resolver)
[vantyr-netlab] PASS: process restart with identical config is equivalent (no LKG/reload claim)
[vantyr-netlab] PASS: malformed bind rejected before socket
[vantyr-netlab] PASS: 0.0.0.0 wildcard rejected before socket
[vantyr-netlab] FULLSTACK SMOKE PASS — Vantyr DNS answered every filtering assertion
[vantyr-netlab] scoped cleanup verified: no containers, networks or volumes for vantyr-network-lab
```

`durable-smoke` additionally uses two disposable projects with their own state
volumes (`vantyr-network-lab-durable` and `vantyr-network-lab-durable-stale`),
chowns each volume root to 65532, builds the same pinned worker image, and ends
with (all waits bounded, stale window 16s for a 12s `stale_after`):

```text
[vantyr-netlab] PASS: corrupt state rejected before any listener (no answer served)
[vantyr-netlab] PASS: durable bootstrap persisted revision
[vantyr-netlab] PASS: durable bootstrap persisted published_at
[vantyr-netlab] PASS: durable bootstrap authored answer
[vantyr-netlab] PASS: durable bootstrap policy denial
[vantyr-netlab] PASS: SIGHUP higher revision changed answer
[vantyr-netlab] PASS: SIGHUP persisted higher revision
[vantyr-netlab] PASS: malformed config reload: applied answer retained
[vantyr-netlab] PASS: stale revision reload: applied answer retained
[vantyr-netlab] PASS: foreign household reload: applied answer retained
[vantyr-netlab] PASS: bind change reload: applied answer retained
[vantyr-netlab] PASS: abrupt restart recovers persisted answer (not changed config)
[vantyr-netlab] PASS: abrupt restart keeps persisted revision
[vantyr-netlab] PASS: abrupt restart keeps original published_at
[vantyr-netlab] PASS: real recovery from persisted bundle after abrupt kill + changed external config
[vantyr-netlab] PASS: stale fixture fresh answer
[vantyr-netlab] PASS: stale policy fails closed to sinkhole
[vantyr-netlab] PASS: stale restart kept persisted revision
[vantyr-netlab] PASS: stale restart kept original published_at
[vantyr-netlab] PASS: fresh reload clears stale fail-closed
[vantyr-netlab] PASS: stale deny persisted across restart; a fresh revision recovered the allow
[vantyr-netlab] DURABLE SMOKE PASS — SIGHUP, rejection, real recovery and stale-age assertions passed
[vantyr-netlab] scoped cleanup verified: no containers, networks or volumes for vantyr-network-lab-durable
[vantyr-netlab] scoped cleanup verified: no containers, networks or volumes for vantyr-network-lab-durable-stale
[vantyr-netlab] state volumes of both disposable projects removed; no resources left
```

One step at a time:

```bash
bash scripts/lab.sh up                  # base: build + start + readiness
bash scripts/lab.sh check               # base assertions only
bash scripts/lab.sh outage              # base outage + recovery
bash scripts/lab.sh smoke               # base full smoke
bash scripts/lab.sh fullstack-up        # guarded create + both resolvers ready
bash scripts/lab.sh fullstack-check     # Vantyr assertions only
bash scripts/lab.sh fullstack-down      # scoped removal + leftover check
bash scripts/lab.sh fullstack-smoke     # guarded create + everything + cleanup
bash scripts/lab.sh durable-up          # guarded durable create + ready
bash scripts/lab.sh durable-down        # scoped removal incl. state volume
bash scripts/lab.sh stale-down          # scoped removal of the stale phase
bash scripts/lab.sh durable-smoke       # guarded create + everything + cleanup
bash scripts/lab.sh list-up             # guarded list-lab create + ready
bash scripts/lab.sh list-check          # list/service assertions only
bash scripts/lab.sh list-down           # scoped removal incl. state volume
bash scripts/lab.sh list-smoke          # guarded create + everything + cleanup
bash scripts/lab.sh ps
bash scripts/lab.sh pause-upstream      # optional delay fault
bash scripts/lab.sh unpause-upstream
bash scripts/lab.sh down                # base scoped removal
```

## Deterministic fixture

Base zone `lab.vantyr.test` (reserved `.test`, documentation addresses only,
RFC 5737 / RFC 3849). The base records used by `smoke` are unchanged.

| Name | Type | TTL | Expected answer |
|---|---|---|---|
| `www.lab.vantyr.test` | A | 300 | `203.0.113.10` |
| `www.lab.vantyr.test` | AAAA | 300 | `2001:db8::10` |
| `alias.lab.vantyr.test` | CNAME | 90 | `www.lab.vantyr.test.` |
| `ttl.lab.vantyr.test` | A | 123 | `198.51.100.7` |
| `sink.lab.vantyr.test` | A | 60 | `192.0.2.0` |
| `missing.lab.vantyr.test` | — | 60 | NXDOMAIN with SOA in authority |

Additional stub records exist only to prove Vantyr is answering, not the stub:
`blocked.lab.vantyr.test` → `198.51.100.99`, `ads.tracker.lab.vantyr.test` →
`198.51.100.98`, and `forwardalias.lab.vantyr.test` → CNAME to the blocked
name. The same query answered directly at `172.26.9.53:15353` returns those
stub answers; through Vantyr it returns Vantyr's own sinkhole.

Vantyr's validated config adds a local authoritative zone `local.vantyr.test.`
with two A records (`192.0.2.10`, `192.0.2.11`), two AAAA records
(`2001:db8::20`, `2001:db8::21`) at `multi.local.vantyr.test.`, a CNAME
`localias.local.vantyr.test.` → `multi.local.vantyr.test.`, and a CNAME
`badalias.local.vantyr.test.` → the denied `blocked.lab.vantyr.test.`. The stub
has no such zone, so these answers can only come from Vantyr.

## Vantyr DNS config contract

[`configs/vantyr.lab.json`](configs/vantyr.lab.json) is a validated fixture
(accepted by `vantyr-dns --check-config`). Its exact values:

- `bind`: `172.26.9.55:15353` (a specific private lab IP, high port) with
  `allow_non_loopback: true` as an explicit opt-in. `0.0.0.0` and other
  unspecified/public addresses are rejected by the worker before any socket;
  [`configs/vantyr.wildcard.json`](configs/vantyr.wildcard.json) exercises that.
- `upstreams`: only `172.26.9.53:15353`, the deterministic stub on labnet.
- `deny`: sinkhole `192.0.2.222` with TTL 30, distinct from every stub answer.
- `profiles`: `standard` allows the `.vantyr.test` lab suffix but has an exact
  deny for `blocked.lab.vantyr.test` and a suffix deny for
  `tracker.lab.vantyr.test`; `restricted` denies that suffix.
- `devices`: source `172.26.9.54` maps to `standard`; the second client at
  `172.26.9.56` is unmapped and therefore gets the restrictive default.
  A source IP is weak association only: it never identifies a person.
- [`configs/vantyr.malformed.json`](configs/vantyr.malformed.json) uses a
  non-IP bind literal and must fail before the listener starts.

DNS has no verified identity: no session, person rule, exception or enrollment
field can select a profile here.

## Durable config contract

[`configs/vantyr.durable.template.json`](configs/vantyr.durable.template.json)
is the same validated schema with placeholders filled by the driver (no flag is
invented). It adds `policy_published_at` and `stale_after_secs` and authors one
probe answer (`probe.local.vantyr.test.`) so a changed answer is visible only
from Vantyr. The worker runs as `netlab-durable-worker` with:

```
--config /etc/vantyr/config/active.json
--state  /state/vantyr-dns.json
--worker netlab-durable-worker
```

The config directory is a read-only bind mount from the disposable project
work dir; the driver replaces `active.json` by copy and sends `SIGHUP` through
the Docker API (`docker kill -s HUP`), never by exec'ing a shell in the
distroless image. `--state-status` runs as a separate `--network none` one-off
with the volume mounted read-only. The single state file is mode `0600`, owned
by 65532, on a named volume labelled for the disposable project only.

## Local-list config contract

[`configs/vantyr.list.template.json`](configs/vantyr.list.template.json) is a
validated c21-schema document (the driver fills revision, publication time,
household, probe answer and the `sources` array). It is served by the real CLI
as `--config /etc/vantyr/config/active.json --state /state/vantyr-dns.json
--worker netlab-list-worker`. The two local sources are bounded regular files
bind-mounted read-only from `work/list/lists`: a hosts file
(`blocked`/`target` bare domains) and an ABP file using only accepted
`||host^`, `@@||host^` and `$important` rules. `source_url` values are
attribution metadata pointing at `example.invalid` and are **never
dereferenced**. The operator catalog defines exactly two synthetic services:
`social` (selected; one exact and one suffix domain) and `unselected` (not
selected). This is a bounded fixture, **not** an exhaustive popular-service
catalog and **not** a fetched subscription — this slice has no fetcher.
`enabled: false`, or removing an entry from `sources`, explicitly drops a
list; a higher revision is required for every reload. No host or controller
identity is claimed by a source IP.

## Assertions made by `list-smoke`

- Initial UDP and TCP hosts-list exact blocks and ABP plain/`$important`
  blocks return Vantyr's `192.0.2.222` sinkhole with TTL 30.
- The selected service's exact domain, suffix root and suffix subdomain are
  blocked; the unselected service's domain stays open.
- A valid list-layer `@@` exception allows the mapped household's allowed name,
  but the same name is denied for the unmapped client and a `@@` exception
  cannot beat the non-overridable safety baseline.
- A local CNAME to a hosts-listed target is denied; no target address leaks.
- A higher-revision reload after changing the hosts file removes the old block
  and blocks the new name; it persists the new revision and publication time.
- A higher-revision candidate with a missing source file, and one with an
  unsupported ABP modifier, are rejected: revision, answer and the exact bytes
  of the persisted bundle are unchanged.
- An abrupt kill followed by an independently changed external config (new
  revision, different publication time, vanished source path and a bad ABP
  file on disk) still serves the persisted validated list bytes and the
  original policy age.
- `enabled: false` and removal from `sources` both take effect only on an
  explicit higher-revision reload; a disabled source's changed file is not
  re-read, while other enabled sources keep blocking.
- A successful run ends with `LIST SMOKE PASS` and verifies that the
  `vantyr-network-lab-list` project left no containers, networks or volumes;
  only its own state volume and generated `work/list` directory are removed.

## Assertions made by `durable-smoke`

- Allowed forwarding from the known client over UDP and TCP (A, AAAA, CNAME).
- Local multi-record A/AAAA and CNAME answers authored in Vantyr's config.
- Exact and suffix denials return Vantyr's sinkhole with TTL 30, while the
  stub answers the same names directly — no stub passthrough.
- A local CNAME and a forwarded CNAME that resolve to a denied target are both
  blocked; denied alias targets never leak addresses.
- The unmapped client gets the restrictive profile even for names the known
  client may resolve.
- Negative answers from the stub keep their 60-second SOA when forwarded by
  Vantyr. No upstream query counter is exposed by this stub, so cache reuse is
  shown by a primed name still being answered during the upstream outage;
  negative-TTL forwarding is asserted from the SOA record.
- With the stub stopped, configured denials still apply and an uncached allowed
  name gets no answer: no failopen and no fallback to a host resolver. Recovery
  is rechecked afterwards.
- Restarting the worker with the same config gives the same allowed/denied
  answers. This is process equivalence only; durable LKG/reload is not
  integrated and is not claimed.
- Malformed bind literal and `0.0.0.0` wildcard configs exit non-zero with a
  validation error and never print a "listening" line; the one-off containers
  run with `--network none`, so no socket can be bound at all.

## Assertions made by `durable-smoke`

- A corrupt state file is rejected before a listener exists: non-zero exit, no
  "listening" line, no answer. Only a disposable host fixture is used; recovery
  is shown with a brand-new project and a brand-new state volume.
- Bootstrap persists revision 20 and its original `published_at`; the authored
  probe answer and a policy denial are served from the real worker.
- `SIGHUP` after replacing the config with revision 21 changes the probe answer
  and persists revision 21 — one atomic version, no listener restart.
- A malformed config, a stale/equal revision, a foreign household and a changed
  bind are each rejected by `SIGHUP`; the previous answer and revision are
  retained every time (no partial application).
- Abrupt `docker kill`, then an independently changed external config (revision
  99, different answers/publication time), then restart: the worker serves the
  **persisted** revision 21 answer and keeps the original `published_at`. This
  is real bundle recovery, not the full-stack same-config restart.
- With a fresh `policy_published_at` and a 12-second `stale_after_secs`, a fresh
  allow is served, then after a bounded 16-second wait the probe is sinkholed
  (fail closed). An abrupt restart keeps the original publication time, so the
  deny persists; a newer revision with a fresh publication time clears it.

## Isolation, bounds and cleanup

- Single private bridge `172.26.9.0/24`, `internal: true` by default.
- Static addresses: stub `172.26.9.53`, known client `172.26.9.54`, Vantyr DNS
  `172.26.9.55`, unknown client `172.26.9.56`.
- No `network_mode: host`, `privileged: true`, Docker socket mount, production
  volume, or host resolver/DHCP/router/firewall change.
- The only extra capability is `NET_BIND_SERVICE` on the pinned CoreDNS
  upstream, which carries a file capability; the lab port is unprivileged
  (15353). It is not granted to the workers or clients.
- All services are read-only with dropped capabilities, no-new-privileges,
  bounded memory/CPU/PIDs and json-file logs capped at 2 x 1 MiB. One-off
  validation containers (including `--state-status`, the corrupt-state probe
  and the volume `chown` helper) add `--network none` where no listener is
  needed.
- Readiness is a real DNS answer, not a port ping; all waits are bounded
  (20 x 1s readiness, 20 x 0.5s reload log, 16s stale-age).
- The project name is guarded to `vantyr-network-lab` or `vantyr-network-lab-*`.
  Every smoke runs a preflight that refuses to proceed if its project already
  has containers, networks **or volumes**, or if `172.26.9.0/24` is in use by
  any network; it never cleans up a project it did not create.
- All smoke drivers install an EXIT trap and verify no containers, networks or
  volumes remain for their project(s). `durable-smoke` deletes only its two
  disposable state volumes via project-scoped `down -v` (no global prune) and
  removes its generated work dir; no household volume or data is touched.
  Other projects on the host (for example `vantyr-dev`) are never inspected
  for deletion.

## Optional host-side access (loopback only)

`compose.host-access.yml` publishes only `127.0.0.1:15553` (UDP/TCP) for the
stub. `compose.vantyr-host-access.yml` publishes only `127.0.0.1:15554`
(UDP/TCP) for Vantyr DNS. Both are opt-in extra `-f` files and both set
`internal: false` for that run because Docker cannot publish from an internal
bridge. Neither changes host DNS settings; a host tool is pointed at the
loopback port explicitly.

```bash
docker compose -f compose.yml -f compose.vantyr.example.yml \
  -f compose.vantyr-host-access.yml -p vantyr-network-lab up -d --build
dig @127.0.0.1 -p 15554 +short www.lab.vantyr.test A     # 203.0.113.10
docker compose -f compose.yml -f compose.vantyr.example.yml \
  -f compose.vantyr-host-access.yml -p vantyr-network-lab down --timeout 5
```

## Out of scope / explicitly unsupported

Authentication, controller API and policy acknowledgment/canary, enrollment
that claims verified identity, a durable event store, and encrypted DNS
client/upstream transports (DoT/DoH/DoQ) are not exercised here and are not
claimed as passing. Unauthenticated local last-known-good state and SIGHUP
reload of a strictly newer revision **are** exercised by `durable-smoke`, with
the limits stated above. Person- or household-specific rules,
competitor/comparison research and public metadata collection are not part of
this lab. DHCP remains on the router.

## Validation commands

```bash
bash -n scripts/lib.sh scripts/lab.sh
docker compose -f compose.yml -p vantyr-network-lab config -q
docker compose -f compose.yml -f compose.vantyr.example.yml -p vantyr-network-lab config -q
docker compose -f compose.yml -f compose.vantyr.example.yml \
  -f compose.vantyr-host-access.yml -p vantyr-network-lab config -q
docker compose -f compose.yml -f compose.vantyr-durable.yml \
  -p vantyr-network-lab-durable config -q
docker compose -f compose.yml -f compose.vantyr-list.yml \
  -p vantyr-network-lab-list config -q
docker run --rm -w /scripts -v "$PWD/scripts:/scripts:ro" \
  koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d \
  -x lab.sh lib.sh
bash scripts/lab.sh smoke
bash scripts/lab.sh fullstack-smoke
bash scripts/lab.sh durable-smoke
bash scripts/lab.sh list-smoke
# Final resource check (replace the project name for the two durable projects):
docker ps -aq --filter "label=com.docker.compose.project=vantyr-network-lab-durable"
docker network ls -q --filter "label=com.docker.compose.project=vantyr-network-lab-durable"
docker volume ls -q --filter "label=com.docker.compose.project=vantyr-network-lab-durable"
```
