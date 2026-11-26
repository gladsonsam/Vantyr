# Vantyr Network — optional UniFi controller integration (adapter foundation)

Status: **foundation slice only**. Read-only discovery against the official
versioned Network API, a pure setup planner and an in-memory mock executor are
implemented and tested. No live controller, credentials or write operation is
part of this slice. The native DNS and Proxy workers remain usable without a
controller integration.

Scope boundary: no DHCP server, RADIUS/EAP, router reboot, VLAN/SSID/firewall
creation, CA installation, frontend messaging or person-identity claim. An IP
or MAC association reported by the controller is a weak network observation,
not proof of the current user on a shared device.

## Primary API evidence (official only)

All route, schema and field facts below come from Ubiquiti's own documentation,
not from a third-party generated specification:

- [Official UniFi API overview](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [Network API reference index](https://developer.ui.com/network/v10.6.109/llms.txt)
- [Machine-readable OpenAPI contract](https://developer.ui.com/network/v10.6.109/openapi.json)
- [Getting started](https://developer.ui.com/network/v10.6.109/gettingstarted) and [AI getting started](https://developer.ui.com/network/v10.6.109/ai-gettingstarted.md)

The reference version used is **`10.6.109`** (`info.version` in the OpenAPI
document). This is the documentation version, **not** a promise about an
installed controller: `GET /v1/info` returns a separate `applicationVersion`
(the spec's own example is `9.1.0`). Both values are reported in capability
discovery; no adapter behaviour assumes they are equal.

Authentication is the `X-API-KEY` header; keys are generated at `unifi.ui.com`.
The documented server bases are:

- local console: `https://{consoleIP}/proxy/network/integration`
- cloud connector: `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/integration`

Resource paths are appended under that base.

### Read-only routes used

| Operation | Route | Pagination |
|---|---|---|
| application info | `GET /v1/info` | none |
| sites | `GET /v1/sites` | `offset`, `limit` |
| networks | `GET /v1/sites/{siteId}/networks` | `offset`, `limit`, optional `filter` |
| network detail | `GET /v1/sites/{siteId}/networks/{networkId}` | none |
| clients | `GET /v1/sites/{siteId}/clients` | `offset`, `limit`, optional `filter` |

Paged responses use `{count, data, limit, offset, totalCount}`. The adapter
sends `offset`/`limit` only; it never sends an operator- or caller-supplied
`filter` string. `PUT /v1/sites/{siteId}/networks/{networkId}` and its
`Integration*NetworkCreateUpdateDto` shapes are documented in the same
contract, but **live writes are deferred** in this slice.

### Documented fields the planner is allowed to touch

`Network details` is discriminated by `management`: `GATEWAY`, `SWITCH` or
`UNMANAGED`. The DNS fields actually present in the official schema are:

- `ipv4Configuration.dhcpConfiguration.dnsServerIpAddressesOverride` — an
  optional array, `minItems: 1`, `maxItems: 4`, under DHCP `mode: SERVER`.
  Both gateway-managed and switch-managed IPv4 DHCP server configurations
  define it. With `mode: RELAY`, or with no DHCP server, the field is not
  applicable.
- `ipv6Configuration.dnsServerIpAddressesOverride` — optional array,
  `minItems: 1`, `maxItems: 4`, on gateway-managed networks. IPv6 also carries
  `interfaceType` (`STATIC` | `PREFIX_DELEGATION`), `clientAddressAssignment`
  (`slaacEnabled`, optional `dhcpConfiguration`) and `routerAdvertisement`
  (`priority`: `LOW` | `MEDIUM` | `HIGH`).

`UNMANAGED` networks have no documented DNS override field: they are treated as
externally managed and produce manual steps, never a speculative write. The
planner touches only the two paths above and never invents a field, endpoint or
value shape. Every other JSON field is retained in the observation's raw
document so a future reviewed executor can preserve unrelated settings exactly.

The documented error body (`Error Message`) has `code`, `message`, `requestId`,
`requestPath`, `statusCode`, `statusName` and `timestamp`.

## Architecture

- `config.rs` — operator-supplied base URL and site allowlist. HTTPS only;
  userinfo, query and fragment are rejected; the path must be the documented
  integration base. A literal controller IP is the strict authority; a
  hostname needs an explicit opt-in because of resolver-controlled rebinding.
  Every resource ID is restricted to `[A-Za-z0-9_-]` so no caller can inject a
  path segment.
- `auth.rs` — `ApiKey` is a `secrecy::SecretString`; it has redacted `Debug`,
  no `Display` and no `Serialize`. It is exposed only while setting the HTTP
  header.
- `transport.rs` — a `Transport` trait with **one** read-only `get(Endpoint)`
  method. There is no caller-supplied URL and no POST/PUT/PATCH/DELETE. The
  reqwest 0.13 implementation uses rustls with verified TLS; an optional
  operator CA is added with `tls_certs_merge`, which keeps platform roots and
  hostname verification on. Redirects are disabled so a different-origin
  redirect cannot be followed. Responses are streamed and capped by byte
  limit; timeouts and page counts are bounded.
- `capabilities.rs` — keeps the documentation version and the controller's
  `applicationVersion` separate, and records the disposition of each operation.
  `NetworkUpdate` is documented but permanently `WriteDeferred` here.
- `discovery.rs` — bounded page collection with offset/advance checks,
  site-allowlist enforcement, and status mapping: `401/403` → auth denied,
  `404` → missing, `405/501` → unsupported, `429/5xx` → unavailable, malformed
  JSON → malformed, oversized body → limit exceeded, repeated offset →
  non-advancing pagination. A failed per-site read is recorded as a capability
  status rather than inferred as success.
- `planner.rs` — pure function from selected network observations, declared
  worker endpoints, dependency evidence and explicit operator approvals to a
  `SetupPlan`. It emits before/proposed/rollback values, dependencies,
  manual steps, verification steps, an expiry and a SHA-256 fingerprint.
- `execution.rs` — in-memory controller only. `preview`, `apply`, `verify` and
  `rollback` implement stale/expiry rejection, per-field idempotency, atomic
  apply, drift detection and rollback that refuses to overwrite a field whose
  current value is neither the proposed value nor the recorded before value.

No network adapter logs, error types or `Debug` output contain the API key.

## Planner constraints

- DNS servers come only from explicitly declared Vantyr worker endpoints; a
  public fallback resolver is never substituted. Both address families are
  capped at the schema maximum of four servers.
- The worker's local default is port **`15353`**, but DHCP can only advertise
  port **`53`**. The plan requires an explicit operator-confirmed external
  `53 → 15353` mapping as a dependency; it never claims that advertising
  `15353` works.
- Existing non-empty DNS overrides (possible split DNS) are preserved: the
  planner returns `needs_manual` until an operator explicitly approves
  replacement, and even then changes only the documented override path.
- IPv6 router advertisement and DHCPv6 settings are never modified. Where the
  IPv6 shape is unrecognized, or switch-managed IPv6 is present, the plan is
  `unknown`/`needs_manual` with manual verification steps.
- Router DHCP remains the DHCP service. No VLAN, SSID or firewall creation is
  assumed. Proxy routing, bypass prevention and CA trust remain separate
  explicit administrator steps.
- Dispositions are `ready`, `needs_manual`, `unsupported` and `unknown`. Only
  `ready` plans are applicable in the mock executor.

## Tests and evidence

`cargo test -p vantyr-network-unifi` — **22 passed, 0 failed**:

- 8 unit tests: secret redaction, URL/ID validation, JSON path helpers that do
  not invent parent objects, unknown-field preservation, fingerprint change,
  hostname opt-in.
- 4 HTTP-contract tests using local `axum`/`rustls` fixtures and rcgen-generated
  certificates: read-only discovery over TLS with a trusted local CA, request
  method and `X-API-KEY` inspection, allowlist enforcement, `401/403/404/405/
  501/500` mapping, malformed/oversized/non-advancing responses, hostname
  rejection **without** the explicit CA and success **with** it.
- 10 planner/execution tests: gateway VLAN 20 with IPv6 and split DNS context,
  switch-managed servers, unmanaged/external DHCP, unknown management, DHCP
  relay, missing dependencies and missing IPv6 worker, worker-only DNS bounds,
  unsupported installed API, expiry/drift/identity rejection, idempotency,
  fingerprinting and conflict-aware rollback that preserves later unrelated
  changes.

## Deferred live validation

- Obtain controller credentials and test read-only discovery against the
  actual installed controller; confirm its `applicationVersion`, site scope and
  the documented routes/fields above before relying on any plan.
- Confirm directly on the controller that `PUT` accepts the exact documented
  DTO shape and that unrelated fields round-trip unchanged. No live write is
  authorized or implemented here.
- Confirm the `53 → 15353` deployment mapping and IPv6 RA/DHCPv6 behaviour on
  one test client before broader deployment.
- Validate DNS-rebinding protection if a hostname authority is ever used; the
  strict mode is a literal controller IP.
- Keep `404` versus missing permission distinct from a genuinely unsupported
  operation on the real controller; do not infer one from the other.

The linked example version is a scoping reference, not a minimum-version
promise. The installed controller's own documentation and capabilities remain
authoritative.
