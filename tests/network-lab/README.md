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

The Vantyr DNS worker is a real binary (`crates/family-dns/src/bin/vantyr-dns.rs`)
with its own accepted real-process and socket tests; its validated configuration
schema lives in `crates/family-dns/src/config.rs`. No integration hook template
is needed any more — `compose.vantyr.example.yml` is a working opt-in override.

Not integrated and therefore **not claimed here**: durable last-known-good
policy persistence or reload, controller acknowledgment/API, authentication or
enrollment, and encrypted DNS (DoT/DoH/DoQ). The restart assertion only re-runs
the *same process with the same config file*; it is not a reload or LKG claim.
DHCP serving is out of scope and stays on the user's router — this lab neither
runs a DHCP server nor changes routes.

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
version. The worker image build context is the repository root but copies only
`tests/network-lab/build/Cargo.toml`, the root `Cargo.lock` and the two required
crate trees (`family-policy`, `family-dns`); it never copies `.`, `.git`,
`.env*`, `secrets/`, the main server or any production data, and it introduces
no dependency fork or low-level DNS parser. The root Cargo manifest/lock are
only *read*, never edited; build output stays in the image's own target scope.

## Run the supported checks

From this directory:

```bash
cd tests/network-lab
bash scripts/lab.sh smoke            # base, upstream only
bash scripts/lab.sh fullstack-smoke  # opt-in Vantyr DNS filtering stack
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
[vantyr-netlab] scoped cleanup verified: no containers or networks for vantyr-network-lab
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

## Assertions made by `fullstack-smoke`

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
  validation containers add `--network none`.
- Readiness is a real DNS answer, not a port ping; all waits are bounded.
- The project name is guarded to `vantyr-network-lab` or `vantyr-network-lab-*`.
  `fullstack-smoke` runs a preflight that refuses to proceed if the project
  already has containers/networks or if `172.26.9.0/24` is in use by any
  network; it never cleans up a project it did not create.
- Both smoke drivers install an EXIT trap and verify no containers or networks
  remain for the project. No global prune, no volume removal, no action on any
  other project.

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

Authentication, controller API and policy acknowledgment, durable event or
last-known-good state, reload of a new policy revision, enrollment that claims
verified identity, and encrypted DNS client/upstream transports (DoT/DoH/DoQ)
are not exercised here and are not claimed as passing. Person- or
household-specific rules, competitor/comparison research and public metadata
collection are not part of this lab. DHCP remains on the router.

## Validation commands

```bash
bash -n scripts/lib.sh scripts/lab.sh
docker compose -f compose.yml -p vantyr-network-lab config -q
docker compose -f compose.yml -f compose.vantyr.example.yml -p vantyr-network-lab config -q
docker compose -f compose.yml -f compose.vantyr.example.yml \
  -f compose.vantyr-host-access.yml -p vantyr-network-lab config -q
docker run --rm -w /scripts -v "$PWD/scripts:/scripts:ro" \
  koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d \
  -x lab.sh lib.sh
```
