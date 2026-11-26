# vantyr-network-unifi

Optional, bounded UniFi Network controller adapter for Vantyr Network.

- Read-only discovery over the official versioned Network API (`10.6.109`
  reference contract), with verified TLS, a redacted `X-API-KEY` and an
  explicit operator URL/site allowlist.
- A pure planner that emits before/proposed/rollback values for the two
  documented DNS override field paths, plus dependencies, manual steps and
  verification steps.
- Mock `preview`/`apply`/`verify`/`rollback` against an in-memory controller:
  fingerprint and expiry checks, stale-plan rejection, idempotency and
  conflict-aware rollback.

There is no live write method, no credential request and no claim about DHCP,
VLANs, SSIDs, firewall policy, CA installation or verified person identity.
See [docs/network-controller-integration.md](../../docs/network-controller-integration.md)
for the official contract evidence, scope and deferred live validation.

```
cargo test -p vantyr-network-unifi
```
