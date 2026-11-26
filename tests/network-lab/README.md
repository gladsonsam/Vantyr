# Vantyr family network — isolated DNS lab

A bounded Docker Compose environment for the native DNS backend. It runs a
deterministic stub resolver and a DNS assertion client on a private Docker
network. It changes nothing on the host: no host DNS, DHCP, router, firewall,
privileged port, Docker socket mount or production data is involved.

## Status

**Supported now:** the upstream resolver contract and DNS wire behaviour
(over UDP and TCP) using maintained tooling.

**Not supported now:** the Vantyr DNS worker is a library crate
(`crates/family-dns`) with loopback unit tests only. There is no worker
executable and no policy-to-DNS wiring in this checkout. This lab does **not**
claim filtering, rewrites, policy-driven sinkholes, cache behaviour, last-known-
good persistence, encrypted transports (DoT/DoH/DoQ) or DHCP. Those remain
later backend slices; see [Retained scope](#retained-scope).

## Verified toolchain and pins

| Component | Pin | Purpose |
|---|---|---|
| Docker Engine / Compose | 29.9.0 / v5.6.0 | runtime used for the recorded run |
| Stub upstream | `coredns/coredns:1.15.0@sha256:0a9d8c8ddf34347eb59aad9a8784f0710de88d6d112726d11d271f9bc6daca26` | authoritative deterministic zone |
| Client base | `docker.io/library/alpine@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f` (3.22.8) | scratch client host |
| DNS client tool | `bind-tools=9.20.30-r0` (ISC BIND `dig`) | UDP/TCP assertions, no wire parser |
| Shell lint | `koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d` | validation only |

Digests were read from the registry tag listings before pinning. The client
image is built locally from the digest-pinned base with a pinned package
version; no unversioned upstream tag is used.

## Run the supported checks

From this directory:

```bash
cd tests/network-lab
bash scripts/lab.sh smoke
```

`smoke` builds the client, starts the stack, runs every assertion below,
injects an upstream outage and recovery, then always removes only this Compose
project. A successful run ends with:

```text
[vantyr-netlab] PASS: UDP A answer
[vantyr-netlab] PASS: TCP A answer
[vantyr-netlab] PASS: AAAA answer
[vantyr-netlab] PASS: CNAME target
[vantyr-netlab] PASS: NXDOMAIN status
[vantyr-netlab] PASS: negative TTL 60s in SOA authority
[vantyr-netlab] PASS: exact A TTL 123s
[vantyr-netlab] PASS: exact CNAME TTL 90s
[vantyr-netlab] PASS: controlled upstream outage (timeout diagnostic, no answer, dig rc=9)
[vantyr-netlab] PASS: upstream recovery (queries answered again)
[vantyr-netlab] SMOKE PASS — every supported lab assertion succeeded
[vantyr-netlab] cleaning up scoped project vantyr-network-lab after successful smoke
```

For manual inspection, use the same driver one step at a time:

```bash
bash scripts/lab.sh up                 # build + start + wait for a real DNS answer
bash scripts/lab.sh check              # assertions only
bash scripts/lab.sh outage             # stop upstream, assert timeout, restart, assert recovery
bash scripts/lab.sh pause-upstream     # optional delay fault: freeze the process
bash scripts/lab.sh unpause-upstream   # resume and wait for readiness
bash scripts/lab.sh ps
bash scripts/lab.sh down               # scoped removal + leftover check
```

## Deterministic fixture

Zone: `lab.vantyr.test` (reserved `.test` domain). Addresses are documentation
ranges only (RFC 5737 / RFC 3849).

| Name | Type | TTL | Expected answer |
|---|---|---|---|
| `www.lab.vantyr.test` | A | 300 | `203.0.113.10` |
| `www.lab.vantyr.test` | AAAA | 300 | `2001:db8::10` |
| `alias.lab.vantyr.test` | CNAME | 90 | `www.lab.vantyr.test.` |
| `ttl.lab.vantyr.test` | A | 123 | `198.51.100.7` |
| `sink.lab.vantyr.test` | A | 60 | `192.0.2.0` (sinkhole-shaped) |
| `missing.lab.vantyr.test` | — | 60 | NXDOMAIN with SOA in authority |

Assertions are made with `dig` inside the client container, always against the
explicit upstream address `172.26.9.53:15353`:

- UDP and TCP A lookups (`+notcp` and `+tcp`) answer identically.
- AAAA and CNAME answers are exact.
- NXDOMAIN returns `status: NXDOMAIN` with a 60-second SOA in the authority
  section (negative caching field is fixed in the zone file).
- A and CNAME record TTLs are exact (123 s and 90 s), not merely non-empty.
- Fault injection: `compose stop upstream` produces a bounded timeout
  (`dig +time=2 +tries=1`, no answer), and `compose up -d upstream` restores
  answers. `pause-upstream` / `unpause-upstream` are available for manual delay
  fault tests.

## Isolation, bounds and cleanup

- Single private bridge `172.26.9.0/24`, `internal: true` by default.
- Static container addresses: upstream `172.26.9.53`, client `172.26.9.54`.
- No `network_mode: host`, no `privileged: true`, no Docker socket mount, no
  production volume, no host resolver/DHCP/router/firewall change.
- Upstream gets one narrow `NET_BIND_SERVICE` capability because the pinned
  binary carries a file capability; it listens on unprivileged port 15353.
- Both services are read-only with dropped capabilities, no-new-privileges,
  96 MiB memory limit, 0.25 CPU, 64 PIDs, and json-file logs capped at 2 x 1 MiB.
- Readiness is a real DNS answer, not just a listening socket.
- `smoke` installs an EXIT trap: any failure removes only the
  `vantyr-network-lab` Compose project. `down` additionally verifies no
  containers or networks remain for that project. There is no global prune,
  no volume removal and no action on any other project.

## Integration hook for a future Vantyr DNS worker

The contract is recorded in [`vantyr.env.example`](vantyr.env.example) and
[`compose.vantyr.example.yml`](compose.vantyr.example.yml). Both are
**templates only** while the worker is a library; they cannot be started today
and prove no filtering behaviour.

### Host-side worker (loopback only)

```bash
cd tests/network-lab
docker compose -f compose.yml -f compose.host-access.yml -p vantyr-network-lab up -d
dig @127.0.0.1 -p 15553 +short www.lab.vantyr.test A
# expected: 203.0.113.10
docker compose -f compose.yml -f compose.host-access.yml -p vantyr-network-lab down --timeout 5
```

`compose.host-access.yml` publishes only `127.0.0.1:15553` for UDP and TCP.
Because Docker does not publish ports on an internal bridge, that override also
sets `internal: false` for this one run; without it the default lab stays
internal. A host-side worker then uses:

```text
VANTYR_DNS_UPSTREAM_HOST=127.0.0.1
VANTYR_DNS_UPSTREAM_PORT=15553
```

No host DNS setting is changed: the worker is pointed at the loopback port
explicitly.

### Container-side worker

Copy `compose.vantyr.example.yml` to `compose.vantyr.override.yml`, uncomment
and complete the service, set `VANTYR_DNS_IMAGE` to a locally built worker
image, then:

```bash
VANTYR_DNS_IMAGE=<locally built worker image> \
  docker compose -f compose.yml -f compose.vantyr.override.yml \
    -p vantyr-network-lab up -d
```

The worker joins `labnet` at `172.26.9.55` and uses the same upstream contract:

```text
VANTYR_DNS_UPSTREAM_HOST=172.26.9.53
VANTYR_DNS_UPSTREAM_PORT=15353
```

## Assertions planned for the worker (not executed here)

Each item below requires a real worker executable and is therefore blocked
today. The shapes are recorded so the next slice can add them without
rediscovering the fixture:

- **Filtering / sinkhole:** query a blocked name through the worker over UDP
  and TCP; expect the policy sinkhole answer (`192.0.2.0` shaped) while an
  allowed name still returns the upstream answer.
- **Rewrites / split DNS:** query an overridden name and a CNAME through the
  worker; expect the local answer to win over the upstream one, with the
  configured TTL.
- **Cache:** prime a name, stop the upstream, query again; expect a bounded
  cached answer with a decreasing TTL, then expiry after the configured window.
- **Failures:** stop the upstream and confirm the worker's configured
  fail-open/fail-closed behaviour and bounded timeout; confirm no fallback to
  any host resolver.
- **Restart:** restart the worker and confirm listeners return on the
  configured host/port and the previously accepted policy revision is loaded.
- **Last-known-good policy ack:** with the controller unavailable, confirm the
  last acknowledged revision stays in force, new allows fail closed while
  existing denies persist, and an ack from a wrong worker or failed canary is
  rejected.

## Retained scope

The full native backend capability set remains in scope for later slices:
UDP/TCP authoritative and forwarding resolution, local and split DNS, filter
syntax and list updates, per-client and per-group rules, query logs with bounded
retention, outage behaviour, DHCP lease handling and client identity, encrypted
DNS (DoT/DoH/DoQ) as client and upstream paths, and enrollment that separates
asserted from verified identity. This lab deliberately covers only the
deterministic upstream and DNS-behaviour foundation.

## Validation commands

```bash
bash -n scripts/lib.sh scripts/lab.sh
docker compose -f compose.yml -p vantyr-network-lab config -q
docker compose -f compose.yml -f compose.host-access.yml -p vantyr-network-lab config -q
docker compose -f compose.yml -f compose.vantyr.example.yml -p vantyr-network-lab config -q
docker run --rm -w /scripts -v "$PWD/scripts:/scripts:ro" \
  koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d \
  -x lab.sh lib.sh
```
