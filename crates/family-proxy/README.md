# family-proxy (Vantyr Proxy)

A bounded HTTP/1 forward proxy and CONNECT gateway. Rama 0.4 owns the HTTP
parser, the eager CONNECT upgrade, the TCP connector and the relay; there is no
custom HTTP/DNS parser and no new proxy engine.

## Default behaviour

- Authenticates a static scoped credential before any egress, evaluates device
  default policy, validates the request target, and enforces header/body/
  deadline and concurrency bounds.
- Every dialled socket is checked by `EgressConnector`. A resolver-aware
  connector resolves once inside the connector and installs a mandatory fixed
  candidate stream, so no second DNS lookup can redirect the dial. Literals
  require an explicit loopback pin.
- A CONNECT is an opaque end-to-end TLS tunnel validated by the client unless
  inspection is explicitly enabled. Proxy credentials and forwarding metadata
  are stripped before an ordinary request reaches the origin.
- HTTP/2 and `Upgrade`/WebSocket are rejected explicitly (505/405), not silently
  bypassed.

## Optional inspection (default OFF)

Inspection is enabled only when `inspection.enabled = true` **and** the
authenticated credential ID is listed in `inspection.enabled_client_ids`.
Everything else stays on the original opaque path.

For an inspected CONNECT:

1. Credential, policy, target and body checks run first. Both paths use the
   same validated `EgressConnector`, so the mode choice never changes where the
   socket is dialled.
2. A short-lived server leaf is issued by `vantyr-network-pki`'s `CaSigner`.
   Its **only** SAN is the exact CONNECT authority (DNS name or IP literal).
   Leaf issuance failure returns an error **before** the 200; there is no
   opaque fallback.
3. The already validated socket is wrapped in Rama's `TlsConnector` with normal
   certificate-chain and hostname verification before the 200. A bad cert or
   bad hostname returns 502/504 before any origin HTTP request is written.
   Production always uses the system roots; no dangerous verifier or test root
   is present in the normal `start`/`start_with` path.
4. Rama's `TlsAcceptorService` terminates only the downstream TLS. A
   `DynamicConfigProvider` rejects a ClientHello whose SNI is not the CONNECT
   authority (rustls server-side certificate selection is not client
   authentication). The decrypted HTTP request's Host/authority is re-checked
   against the CONNECT authority, proxy credentials and forwarding metadata
   are stripped again, and `HttpMitmRelay` serves h1 over the pre-established
   upstream TLS socket.
5. The outer concurrency permit, h1 header timeout, body frame deadlines and
   graceful shutdown still apply. Upstream TLS has its own handshake timeout;
   the decrypted session has a bounded lifetime. Either direction stalling
   releases the permit.

ALPN is `http/1.1` only. HTTP/2 and WebSocket remain unsupported inside the
decrypted connection; a prior-knowledge h2 stream receives 505.

### Narrow opaque exceptions

`inspection.exceptions` entries are exact `host`, `port`, credential-scoped and
expiring (RFC3339 `expires_at`, at most seven days ahead when loading config).
They are validated against already approved
destinations, so they cannot widen the destination or bypass policy/egress.
They only select the opaque path for that one client after the same credential
and egress checks. An expired exception returns to inspection.

Destination ports are explicit nonzero approvals, including standard HTTP 80
and HTTPS 443. The unprivileged-port restriction applies to the local listener,
not to the remote service being contacted.

### Configuration and key custody

Config stores **paths only**: `ca_dir`, `ca_name` and a `secret_file_path`.
`vantyr-network-pki` reads the operator passphrase from a regular, non-symlink,
`0600` file bounded in size; the passphrase and unlocked CA key are held in
memory only and are not written back to disk. There is no private-key field, no
trust-install field and no HTTP API in this crate.

### Test seam

`InspectionRuntime::from_signer_test_seam` and
`ProxyServer::start_with_test_tls` exist only for real loopback TLS tests. They
inject an in-memory CA and explicit upstream trust anchors. The binary,
`start()` and `start_with()` never call them. Tests under `tests/inspection.rs`
verify the issued chain against a client trusting only the unique inspection
CA, bad cert/hostname pre-200 failure with zero origin HTTP, no fallback on
leaf failure, SNI/inner-Host escape rejection, credential stripping, raw
exception plus expiry, and permit release on a stalled handshake in each
direction.

## Opt-in centrally issued credentials (foundation, default OFF)

Ordinary `start()`/`start_with()` remain bootstrap-only and attribute no person.
`ProxyServer::start_with_session_auth(...)` is the explicit opt-in seam that
wires a `CredentialStore` plus a typed `SessionEvidenceVerifier`:

- A proxy credential is a NEW, hash-only family: id + one-time secret, verified
  with a fixed-width constant-time compare; expiry, revocation, rotation,
  binding generation, household, device, worker-kind `proxy`, audience
  `vantyr-proxy-client` and per-command scope (`proxy_connect`/`proxy_http`) are
  all checked. BYOD setup grants, gateway Bearer credentials and CA trust are
  separate families and cannot authorize proxy traffic.
- Person policy requires additional, independently verifiable session evidence
  (`x-vantyr-session-evidence`, canonical JSON) checked against the credential's
  household/device/generation/kind, audience, command and an active assignment.
  IP, labels and header claims are never identity. Shared devices cannot carry a
  verified person. Invalid evidence denies the request (static `evidence_*`
  code); it never degrades to a person-bearing identity.
- Both headers are stripped before an origin is contacted, including on the
  decrypted inspection path. Evidence is single-use at authentication: a later
  policy/body/TLS denial still consumes it (fail closed; no give-back TOCTOU).
  Replay state lives with the receipt until it is safely expired/revoked and
  past retention; a full bound fails closed with `evidence_bound_exceeded`.
  Bootstrap and central credentials share the bounded failure/cooldown tracker.
- The foundation itself implements no server authority: `LocalEvidenceVerifier`
  is an in-memory authority for tests; `NoEvidenceVerifier` is the default-off
  verifier. See [the proxy credential contract](../../../docs/proxy-session-credentials.md)
  for the accepted wire contract and the live-CONNECT revocation limitation.
  Zero new dependencies were introduced by the foundation.

## Opt-in server-backed authority (explicit `--server-auth`)

`server_authority::RemoteCredentialStore` pulls a hash-only credential set from
the real server over a gateway Bearer scoped with the explicit
`introspect_proxy` command and `kind = proxy`; `HttpEvidenceVerifier` implements
the accepted verifier seam against the server's scoped introspection route. A
bounded TTL (1..=60 s, default 5) makes a stale or unreachable authority deny
every new request; there is no bootstrap fallback. The CLI only reaches this
path with `--server-auth` plus `VANTYR_PROXY_INTROSPECTION_URL`,
`VANTYR_PROXY_WORKER_TOKEN`, `VANTYR_PROXY_GATEWAY_ID` and optional
`VANTYR_PROXY_SYNC_TTL_SECS`. Production requires an `https://` base URL.

These are two current, explicit operator choices — bootstrap mode (`start()`)
and server-backed mode (`--server-auth`) — not a v1/v2 wire contract or a
fallback authority path. A server-backed worker never falls back to bootstrap
credentials when the authority is stale or unreachable.

Revocation reaches new requests within one sync TTL (plus network latency).
An established opaque CONNECT is a raw tunnel and is **not** retroactively
closed; it ends on idle timeout, normal close, restart or an out-of-band
termination. See [the integration design](../../../docs/proxy-management-integration.md)
for exact routes, DTOs, grants and limits.

## Out of scope / known limits

- No CA trust installation, enrollment agent, client trust removal, CRL/OCSP,
  SSO/RADIUS/UniFi integration, frontend API or router/AP changes.
- No HTTP/2 or WebSocket support; no full MITM traffic-rewrite engine.
- PKI hardening limits are inherited: secret wrappers zeroize owned values on
  drop, but temporary plaintext buffers and decrypted payload copies are **not**
  guaranteed to be zeroized. This is not a claim of complete process-memory
  erasure; recovered certificate-metadata consistency remains hardening work.
- An inspection CA must be provisioned and client trust deployed by a separate
  operator flow. Until that happens, clients that do not trust the inspection
  CA will fail inspected CONNECTs — by design, fail closed.
