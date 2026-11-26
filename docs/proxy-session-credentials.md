# Vantyr Proxy — centrally issued credentials and verified session evidence

Status: **worker-side foundation implemented locally, pending review**. The
server authority, issuance/revocation API and any UI integration described in
section 6 are **not implemented and not claimed**. This is a bounded contract
for parent coordination/review, not an end-to-end authentication delivery.

Scope ownership: `crates/family-proxy/**` and this document only. No server,
DNS, network-runtime, PKI, frontend, root manifest or lock-file changes were
made. No trust, household, host, CA or network state was touched.

## 1. What the gap is

The accepted proxy worker (`crates/family-proxy`) authenticates static, private
config bootstrap tokens and always evaluates with `session: None`. The accepted
server BYOD enrollment service (`server/src/network/enroll_service.rs`) issues
single-use setup grants and time-bounded **session receipts** and states
explicitly that it "never produces proxy credentials, never installs trust
material and never claims network coverage". A setup grant or receipt therefore
cannot, by itself, authorize proxy traffic.

This increment adds an **opt-in, worker-side credential lifecycle and
authorization library**. It does not fabricate a server API or claim that a real
controller exists.

## 2. Implemented worker foundation

- `crates/family-proxy/src/credentials.rs` — hash-only centrally scoped proxy
  credential lifecycle: `issue`, `verify`, `rotate`, `revoke`, `prune`. Only a
  SHA-256 hex digest is retained; verification is a fixed-width constant-time
  comparison (Rama `ct_eq_bytes`) for known **and** unknown credential ids.
  Checks: malformed shape, unknown id, wrong secret, expiry, revocation,
  household, configured device binding, worker kind, audience and per-command
  scope, and binding generation (rotation invalidates old secrets).
- `crates/family-proxy/src/session_evidence.rs` — typed
  `SessionEvidenceVerifier` interface, a working `LocalEvidenceVerifier`
  authority with digest registration, scope checks and single-use nonce replay
  protection, and a `NoEvidenceVerifier` that denies all evidence by default.
  Successful verification yields a `family_policy::Session` with
  `Assurance::Verified`, `SessionSource::ProxyCredential`, the verified person
  and **only** active assignments that actually bind that person to that device.
  A shared-household-kind credential can never attribute a person. Identity is
  never inferred from an IP address, device label, username or unverified header
  claim.
- `AuthState::with_session_auth` and `ProxyServer::start_with_session_auth` are
  the explicit opt-in seam. Ordinary `start()`/`start_with()` keep bootstrap-only
  authentication and deny all session evidence, so existing deployments are
  unchanged.
- Evidence is carried in `x-vantyr-session-evidence` as bounded UTF-8 canonical
  JSON. It is stripped by Rama maintained layers on plain HTTP forwarding and
  explicitly removed again on the optional decrypted-inspection path, alongside
  `Proxy-Authorization`.
- Failure codes are fixed and bounded: `credential_*` and `evidence_*` codes are
  stable response-body strings. Secrets, digests, person ids and device ids are
  never rendered by `Debug`, `Display` or an error code.

All previously accepted properties remain intact: hash-only secret custody,
destination allowlisting with validated candidates and no DNS rebinding,
upstream TLS verified before CONNECT 200, explicit h1/h2/Upgrade restrictions,
default-off inspection, narrow expiring exceptions and safety-baseline policy
authority. No dependency or feature was added; SHA-256 is the already-pinned
`vantyr-network-pki::metadata::sha256_hex` primitive and the constant-time
comparison is already-pinned Rama. No `Cargo.lock` write occurred.

## 3. Credential families must stay distinct

Nothing in this contract merges these families. A token in one family must
never authenticate another.

| Family | Purpose | Where verified | Grants proxy traffic? |
|---|---|---|---|
| **Proxy credential** (this increment) | Device-bound, person-scoped capability to use the proxy | Worker credential store (server authority required for production) | Yes, once the server authority exists |
| Gateway worker Bearer | DNS/proxy worker heartbeat, policy read, DNS status report | Server `gateway_auth.rs` (audience/command/household/kind/gateway/expiry/revocation) | No — worker control plane only |
| BYOD setup grant / session receipt | One-time enrollment and a time-bounded *verified-person fact* | Server `enroll_service.rs` | No — not a proxy credential |
| Inspection CA trust | Public certificate trust on a client | Client trust store, installed by explicit user approval | No — trust is not authorization or network coverage |

## 4. Worker wire contract (implemented shape)

- `Proxy-Authorization: Basic <id>:<secret>`, where `id` is the public UUID of a
  proxy credential and `secret` is a 32..=128 character high-entropy value.
  Only the digest is stored. Audience `vantyr-proxy-client`, kind `proxy`.
- Commands are opt-in and allowlisted: `proxy_connect` and `proxy_http`. The
  worker requires the command matching the actual request method.
- `x-vantyr-session-evidence: <canonical JSON>` — schema 1, fields:
  `schema`, `session_id`, `household_id`, `device_id`, `verified_person`
  (nullable), `binding_generation`, `household_kind` (`personal`/`shared`),
  `audience` (`vantyr-proxy-session`), `command`, `issued_at`, `expires_at`,
  `nonce`. The authority registers only the payload digest; the worker
  recomputes it and compares in constant time. A reused `nonce` is rejected.
- Verified identity requires the evidence to match the already authenticated
  credential's household, device, binding generation and household-kind, to
  carry the correct audience and command, and to correspond to an **active
  assignment**. Invalid evidence denies the whole request; it never degrades to
  a person-bearing identity.

## 5. Fixed failure codes

`credential_malformed`, `credential_unknown`, `credential_invalid_secret`,
`credential_expired`, `credential_revoked`, `credential_wrong_household`,
`credential_wrong_device`, `credential_wrong_kind`, `credential_wrong_audience`,
`credential_command_not_allowed`, `credential_generation_mismatch`,
`credential_bound_exceeded`;
`evidence_unsupported`, `evidence_malformed`, `evidence_unknown`,
`evidence_invalid_digest`, `evidence_expired`, `evidence_revoked`,
`evidence_replay`, `evidence_audience_mismatch`, `evidence_command_mismatch`,
`evidence_household_mismatch`, `evidence_device_mismatch`,
`evidence_generation_mismatch`, `evidence_kind_mismatch`,
`evidence_no_verified_person`, `evidence_no_assignment`,
`evidence_bound_exceeded`, `evidence_duplicate`, `evidence_nonce_conflict`.

Replay state belongs to the receipt identity, not to a separate nonce map: a
still-live receipt keeps denying replays through pruning and the bounded-capacity
path, and a duplicate session id or nonce cannot reset consumption. Expired and
revoked receipts are reclaimed only after their audit retention; when every slot
is still live, issuance fails closed with `evidence_bound_exceeded` rather than
evicting valid replay protection. The same bounded failure/cooldown tracker
covers bootstrap and centrally issued credentials plus failed evidence checks,
keyed only by the public credential id — no secret or identity enters it.

Evidence is deliberately **single-use at authentication time**: the receipt is
consumed after all scope checks succeed and before target/policy/body/TLS
evaluation. A request that is denied later still consumes it; there is no
post-denial "give it back" path that would introduce a time-of-check/time-of-use
window. This fail-closed semantic is covered by tests.

## 6. Server seam — precise requirements for parent implementation/review

The following is a **proposed contract**, not delivered code and not a route
invented by the frontend. The staged frontend demo (SHA `2f42aa38`) is
demo-only until an actual scoped server implementation and worker integration
are reviewed. There is no HTTP endpoint implemented here; route names, status
codes and DTOs below are for parent review only.

### 6.1 Credential records

A server-side proxy credential row must expose (sanitized, no secret or hash):

`id`, `label`, `personId` and a read-only `personLabel`, `deviceId` (optional),
`createdAt`, `expiresAt`, `lastUsedAt`, `revoked`, `revokedAt`, `scopes`
(allowlisted: `proxy_connect`, `proxy_http`).

`personLabel` is a display projection of an explicitly mapped principal in the
**same household**, never a lookup by display name and never an identity claim.
`deviceId` optional means a credential may be bound to a specific configured
device; when present it must be validated against the same household and the
same household-kind (`personal`/`shared`) that the worker checks.

### 6.2 Issue

`issue(personId, deviceId?, label, expiry) -> secret ONCE`.

- The server must resolve `personId` from the authenticated, household-scoped
  admin/binding context, recheck the grant under the household row lock, and
  reject an unknown or cross-household person or device.
- `expiry` is server-bounded; a caller cannot request an unbounded credential.
- The plaintext secret is returned **only** in this one-time issuance response;
  only its SHA-256 digest is persisted, matching the accepted BYOD/gateway
  custody pattern. No digest, secret or person value is logged.
- `label` is bounded and trimmed; it is display metadata, never an identity or
  policy input.

### 6.3 Revoke

- `revokeOne(id)` marks a single credential revoked at the current instant.
- `revokeAllByPersonId(personId)` revokes every credential for that **person id**
  in the household — never by display name, label, device, IP or an asserted
  claim. Both operations are atomic under the household lock and idempotent.
- Revocation of a credential must, **in the same transaction**, terminate every
  live session it owns: set session `endedAt`, mark the session ended with an
  explicit reason (`credential_revoked`), and invalidate any unexpired evidence
  so replay/re-verification fails. Listing a credential as revoked while its
  sessions remain live is not an acceptable result.

### 6.4 Session records

A server-side session row must expose `id`, `credentialId`, `deviceId`,
`personLabel` (display only), `start`, `lastActive`, `expiry`, `end`. Status is
derived from start/end/expiry and revocation, not from a stored "protected"
badge. `lastActive` is an observation, not proof of traffic coverage.

### 6.5 Availability and status/ack semantics

- Availability is derived from `!revoked && now < expiry` plus the live session
  state. It does **not** assert DNS/proxy enforcement, inspection coverage or
  that a device is actually routed through the proxy.
- There is no policy ack or canary attestation in this increment. The accepted
  placeholder canary remains a placeholder; a saved/issued credential or a
  listed session is **not** proof that traffic is covered. Any future worker
  status/ack protocol must be a separate, explicitly reviewed increment.
- The server is the authority for issuance, introspection and revocation. The
  worker must not accept a client-supplied label, person name, IP or header as a
  substitute for authoritative evidence. All new UI remains demo-only until
  this server seam and the worker integration have been reviewed together.

### 6.6 Live-CONNECT revocation limitation (must be stated honestly)

Revocation takes effect only for requests authenticated **after** the worker
observes it. An established CONNECT is an opaque TCP tunnel that is never
re-authenticated; the proxy does not terminate client TLS on the opaque path and
therefore cannot inject a 407 or otherwise close a live tunnel merely because a
credential was revoked server-side. The documented consequences are:

- Production needs bounded revocation propagation (server push or short-TTL
  introspection cache) from the server authority to each worker; this is **not**
  implemented here. Until it exists, a worker can only enforce revocations in
  its local in-memory store.
- A revoked credential stops all **new** HTTP requests and CONNECT tunnels once
  observed; an already-established tunnel continues until idle timeout, normal
  close, worker restart, or explicit connection termination by a separate
  mechanism. The optional inspected path has its own bounded session lifetime.
- No claim is made of instantaneous, retroactive interception of an open
  tunnel. This limitation must be surfaced in any UI that shows revocation.

## 7. Limits and non-goals

No server implementation, HTTP endpoint, UI wiring, trust installation, CA or
host/network state changes, RADIUS/Wi-Fi integration, mobile enrollment, custom
crypto/wire parser/TLS stack, or HTTP/2/WebSocket support. The local in-memory
authority is a test and foundation seam, not a durable production database.

## 8. Test evidence

`cargo test -p family-proxy` — 74 tests: 37 library (credential lifecycle,
evidence scope/replay/revocation/expiry, bounds, Debug redaction), 2 binary,
10 inspection, 16 original integration, and 9 new real-loopback HTTP/CONNECT
tests (valid credential + evidence to origin with both headers stripped,
revoked credential 407 before egress, revoked/replayed evidence 403 before
egress, CONNECT with matching command and command-mismatch denial, person rules
requiring evidence, concurrent replay yielding exactly one success, revocation
visible to all subsequent verifications, and bootstrap-only worker rejecting a
centrally issued credential). `cargo check --locked --offline -p family-proxy`
passes with no new dependencies.
