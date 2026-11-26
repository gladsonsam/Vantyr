# Family network gateway — operations and security runbook (foundation)

This is a **foundation for review, not a deployment procedure**. It records what can be
run today and what must be designed, implemented and verified before any household use.
It deliberately names no new binary, flag, listen port or DNS record value beyond the
operator-owned name given in the brief.

Status labels used throughout:

- **[VERIFIED]** — an existing command/constraint taken from a tracked document in this
  repository. It does not depend on the family-network feature existing.
- **[REQUIRED]** — a property the future implementation must have; not yet available.
- **[PLANNED — UNVERIFIED]** — a future procedure. No runtime, binary interface or flag
  is asserted. Do not run it against household infrastructure.
- **[BRIEF-SOURCED]** — an arrangement described in the brief, **not verified against a
  live deployment**; confirm it before relying on it (section 10).

## 1. Scope and hard boundaries

Authorized in this slice: this document and isolated local review/tests against a
throwaway database. **Not authorized**: any household deployment; DHCP, router or
firewall edits; installing a CA on household/client machines; reboots; releases; or a
merge to `main`. Mobile clients are deferred. The companion implementation note is a
separate slice; this file does not treat unfinished code as deployed truth. The network
topology in the brief (split DNS, Traefik, Cloudflared) is an assumption, not a verified
deployment fact (section 10).

Two absolute rules:

1. **No blanket fail-open and no TLS-verification bypass.** If trust or state cannot be
   established, the system stops making new trust decisions and keeps the last locally
   validated, durably persisted known-good configuration on the worker (section 5); it
   must not start accepting everything or skipping certificate validation. Verify mode
   stays on in every path, including CONNECT/interception paths.
2. **Network enrollment never grants monitoring or control.** Enrolling a client into the
   family network must not enable Recall, keystrokes, screen/audio capture, remote input,
   files/terminal/scripts, or elevate any dashboard/operator privilege. Network trust and
   module grants are independent; see the existing module-gate model in
   [`agent/docs/server-commands.md`](../agent/docs/server-commands.md) and the authority
   boundary in [`agent/docs/module-authority-design.md`](../agent/docs/module-authority-design.md).

The project is explicitly for experimentation, not a hardened product
([`README.md`](../README.md), [`SECURITY.md`](../SECURITY.md)); this runbook does not
change that classification.

## 2. Isolated local test prerequisites

Reuse the existing throwaway PostgreSQL pattern. These are the verified local test steps
for this section; section 8 lists the verified regression commands.

```sh
just db-up
export DATABASE_URL=postgres://vantyr:vantyr@127.0.0.1:55432/vantyr
SQLX_OFFLINE=true DATABASE_URL=$DATABASE_URL cargo test --workspace --locked
just db-down
```

Source: [`server/docs/testing.md`](../server/docs/testing.md) and the `db-up`/`db-down`
recipes in the [`justfile`](../justfile). Notes that still apply: the role needs
`CREATEDB`, `#[sqlx::test]` creates and drops per-test databases, a failed test keeps its
database for inspection, and `SQLX_OFFLINE=true` uses the committed `server/.sqlx` cache
([`server/docs/database.md`](../server/docs/database.md)). Never point `DATABASE_URL` at a
database anyone cares about. `just check` is the full local equivalent of CI (server,
sqlx cache, dashboard, agent UI, agent) and is the regression gate in section 8.

There is **no controller, DNS service or proxy binary to run yet**. Any local exercise of
those components is [PLANNED — UNVERIFIED] and must use the same disposable, localhost-only
posture; do not point a future controller at the production database or at household DNS.

## 3. Independent controller / DNS / proxy lifecycles

[REQUIRED] Controller, resolver/DNS service, and egress proxy are **separate lifecycles**
with separate configuration and state:

- Each can be started, stopped and restarted without taking the others down, and each
  failure mode is defined (for example: proxy down while controller and DNS stay up).
- Stopping one component must not silently widen trust, but failures are **not
  availability guarantees**: loss of the controller freezes new decisions; loss of DNS
  leaves the split-DNS configuration intact but makes the configured app resolution path
  unavailable until DNS is restored; loss of the proxy ends family-network egress on the
  configured path only — it cannot stop off-path clients or direct egress without
  network-level enforcement, which is out of scope here. None of these failures is a
  reason to fall back to unfiltered traffic.
- No controller, DNS or agent component shares the server's admin credential or receives
  the operator CA private key. The dedicated signer is necessarily authorized to use that
  key to sign (it may be the proxy's signer); its authority is limited to signing, not to
  controlling policy or other components, and it unlocks the key into memory only
  (section 4).
- Every lifecycle change is auditable (who, when, which component, resulting state).
- Reversibility is part of the lifecycle: a stop/decommission procedure includes
  restoring client proxy settings and trust state, not just terminating a process.

[PLANNED — UNVERIFIED] Actual service units, containers, health checks and command
interfaces must be specified in the implementation note and exercised locally first.

## 4. Operator CA: creation, custody, rotation, recovery, revocation

[REQUIRED] The trust anchor is **unique per deployment and generated by the operator**.
No CA key, certificate, passphrase or default trust bundle is shipped in the repository,
a container image, a release artifact, a log line or a test fixture. The server-side
Recall keyring practice in [`docs/recall-security.md`](recall-security.md) is the
analogy to follow for custody (operator-held secret, restricted file mode, off-host
recovery copy) — it is **not** the same key and must not be reused for the network CA.

- **Create**: operator-only, on a trusted machine, before any client is enrolled; record
  the CA identity/fingerprint in the deployment record so a client can be shown exactly
  what it is being asked to trust.
- **Custody**: private key offline or in operator-controlled encrypted storage, least
  privilege, never as plaintext on disk on the proxy host (or any other host), never in
  Git, images, logs or backups except inside the operator's encrypted escrow. An
  authorized signer may unlock the key from that custody into **memory only**, via a
  distinct operator unlock or an external signer; this is controlled use of the key, not
  a claim that no component ever holds it (section 3).
- **Rotate**: issue a new CA, publish it as a new revision (section 5), re-enroll
  clients during an overlap window, then retire the old CA. Rotation never silently
  replaces trust on a client; removing the old CA from client trust stores or explicitly
  re-enrolling is part of retirement, with operator approval.
- **Recover**: restore from the offline escrow. Losing the key is not repaired by
  generating a fresh CA and telling clients to accept it — that requires explicit
  re-enrollment and revocation of the old anchor.
- **Revoke**: maintain a revocation record for the CA and for issued **leaf/server
  (intercept) certificates**; this design does not assume mTLS client certificates.
  A ledger entry alone does **not** remove CA trust from a client: trust-store removal
  or explicit re-enrollment is required and must be evidenced. Revocation is effective
  before any new trust decision and is reflected in the audit trail. "Stopped the proxy"
  is not revocation.

[PLANNED — UNVERIFIED] The concrete tooling, file formats and commands do not exist
yet; none are invented here.

## 5. Revision state: saved vs applied-ack, rollback and LKG outages

[REQUIRED] Three distinct states must never be conflated:

1. **Saved** — a revision is durably persisted in the controller/database. This is not
   proof that any client runs it.
2. **Applied-ack** — a specific client reports it applied revision *R*. An ack must be
   bound to `(client identity, revision, command/request id)`; unbound or stale acks are
   not evidence. This mirrors the existing `expected_revision` / `command_id` and
   `module_disable_ack` pattern in
   [`agent/docs/server-commands.md`](../agent/docs/server-commands.md), and the
   `history_frame_ack` pattern there. No fleet-wide "applied" claim from a single ack.
3. **Last known good (LKG)** — the last revision a worker has locally validated and
   durably persisted. That persisted policy is **authoritative on the worker even if the
   controller never received its ack**; a controller-side ack is evidence of application,
   not the source of truth for the worker's effective policy.

Operational rules:

- Never report "deployed" from a database write alone; report saved and applied counts
  separately, with per-client ack state and age. A missing ack is uncertainty in the
  controller's view, not proof that a worker left LKG.
- Missing/late ack means **unknown to the controller, not failed-open at the worker**:
  the worker keeps serving its locally validated, durably persisted LKG policy; the
  controller retries reporting within a bounded budget and surfaces the uncertainty.
- **Rollback publishes a new, strictly higher revision whose content restores the prior
  settings.** Never decrement, reuse or reset a revision to roll back: a reissued old
  number is indistinguishable from a stale/replayed command and must be rejected. This
  follows the revision high-water-mark and no-reset rule already documented for module
  state in [`agent/docs/module-authority-design.md`](../agent/docs/module-authority-design.md).
- **Controller/LKG outages**: workers continue on locally persisted LKG; reconciliation
  from the controller must **not regress a worker's persisted policy merely because an
  ack was lost or delayed**. New enrollment, CA-trust changes and proxy/public-CA setting
  changes are paused until the controller is healthy and the ack path is verified. No TLS
  bypass, no "accept any CA" fallback, no unconditional direct egress as an outage
  workaround.

[PLANNED — UNVERIFIED] The exact revision schema, ack timeout values, and API surface
are implementation work.

## 6. Events, logs, retention and attribution

[REQUIRED] Family-network events (enrollment, revision save/apply, CA rotation/revocation,
proxy setting changes, resolver/proxy lifecycle, denials and errors) are:

- **Bounded** by both count and time, with an explicit retention window and a documented
  purge path; unbounded growth is a defect. The existing bounded-retention approach for
  Recall is described in [`server/docs/recall-retention.md`](../server/docs/recall-retention.md).
- **Privacy-minimal**: record identifiers, revision ids, decisions and outcomes, not
  full URLs, page contents, paths, payloads, credentials or keystrokes. Do not add family
  network records to Recall/search correlation or to a longer-lived audit stream without
  a separate, explicit authorization.
- **Honest about attribution**: a client id, reported hostname or source IP identifies a
  device/observation, not a person. NAT/CGNAT, shared machines, shared TVs and changing
  users make "who was there" uncertain. Logs are evidence that an observation came from
  an enrolled client, not proof of the human actor or of complete coverage. Preserve that
  uncertainty in the operator UI and in any report (the metadata-only diagnostic report
  is a good precedent: [`agent/docs/diagnostic-report.md`](../agent/docs/diagnostic-report.md)).

Do not log CA private material, ack tokens or raw proxy traffic. Redaction failures are
incidents, not cosmetic bugs.

## 7. Backup and recovery scope

**[VERIFIED] What exists today.** [`docs/recall-security.md`](recall-security.md)
documents `tools/secure_backup.py`: an `age`-encrypted backup of the PostgreSQL custom
dump, the Recall tree, the Recall keyring and Compose configuration including `.env`,
with the private recovery identity held off-host. `verify` authenticates the bytes and
checks archive paths and the dump header, but is **not** a full restore test; a separate
isolated `pg_restore` into a disposable database is part of that doc's procedure. It also
states that restoring an old Compose file over a newer deployment is not a rollback, and
that unlinking old copies does not guarantee erasure. These facts and procedures are
unchanged by this feature.

[REQUIRED] **What the verified backup does and does not cover.** A full `pg_dump -Fc` of
the same database already includes any future controller policy, revision and ack tables
automatically; do not list those tables as a backup gap. The real gaps are state kept
**outside that dump and Compose file**: the operator CA private-key escrow, any
separate-host controller/DNS/proxy configuration, and any external stores the feature
introduces. Also, `verify` authenticates bytes but does not demonstrate a restore — a
restore of those tables has not been tested for this feature. Do not claim a backup is
restorable for this feature until the operator-controlled encrypted backup covers those
external items and a documented re-enrollment-from-scratch procedure exists where
needed. Restoring an older database or binary against a newer CA/revision state is not a
rollback (same principle as the Recall keyring warning in
[`docs/recall-security.md`](recall-security.md)).

[PLANNED — UNVERIFIED] Add a restore rehearsal to the pilot exit criteria: restore into
an isolated local instance only, verify CA custody and revision/ack state, and confirm
client settings can be returned to their pre-pilot values. No household restore is in
scope for this slice.

## 8. Dependency lock and update regression checklist

The Rust workspace uses a committed `Cargo.lock` and checked build modes
([`README.md`](../README.md), [`server/docs/ARCHITECTURE.md`](../server/docs/ARCHITECTURE.md)).
Before accepting any dependency change related to this feature:

1. **[VERIFIED]** Run `just check` (fmt, clippy, tests, sqlx cache, frontend, agent UI,
   agent) with a throwaway `DATABASE_URL` from section 2; keep `SQLX_OFFLINE=true` and
   `--locked` as the recipes in the [`justfile`](../justfile) do.
2. **[VERIFIED]** If SQL changed, regenerate/commit `server/.sqlx` with `just sqlx-prepare`
   and confirm `just sqlx-check` passes ([`server/docs/database.md`](../server/docs/database.md)).
3. **[REQUIRED]** Review the lockfile diff for any new proxy/TLS/DNS crate and for
   transitive downgrades; record why each change is needed. Do not upgrade the project's
   pinned toolchains as an incidental fix.
4. **[REQUIRED]** Re-verify the two absolute rules from section 1 after every update:
   no blanket fail-open, no TLS-verification bypass, including on CONNECT/intercept
   paths. A dependency that makes verification optional by default is a blocker.
5. **[REQUIRED]** Re-run the one-client pilot (section 9) after any proxy engine,
   resolver or certificate-handling change; a green unit suite is not pilot evidence.

**Backend feasibility caveat (do not resolve here).** Hudsucker's raw CONNECT path
bypasses the custom connector, and Rama 0.4 is under executable evaluation. Until an
executable proves the interception path and its behavior, this document **does not fix**
the engine choice, listen ports, flags, or a promise that CONNECT traffic is covered.
Treat any such claim as unverified.

## 9. One-client opt-in pilot and reversibility

[PLANNED — UNVERIFIED] The only acceptable first trial is a **single, explicitly
opted-in client** with operator approval, a narrow scope and a short review window:

- No fleet-wide push, no household-wide DNS/DHCP/router/firewall change, no CA install
  on machines outside the pilot, no release and no `main` merge. Mobile is deferred.
- Before: capture the client's existing proxy and public-CA trust settings and the exact
  operator-owned app FQDN in use, so "reversible" means demonstrably restorable, not
  merely "we think we changed one setting".
- During: watch the three revision states separately (section 5) and log only the bounded
  event set (section 6). Do not enable any Recall/keystroke/remote capability because the
  client joined the network (section 1).
- Exit/rollback: publish a **new higher revision** reverting policy, restore the client's
  proxy and public-CA settings, revoke any issued leaf/server (intercept) certificates,
  and remove the pilot CA from the client's trust store or explicitly re-enroll the
  client — a revocation ledger entry alone does not remove trust. Record evidence that
  the pre-pilot state was actually restored.
- Shared-TV caveat: a household TV or shared account is not a single-user pilot; do not
  use one to claim coverage or attribution.

## 10. DNS, ingress/egress separation and loop avoidance

**[BRIEF-SOURCED — not verified against a live deployment; required to preserve.]** The
brief describes an existing split-DNS arrangement in which the operator-owned full app
name, written as `full-app-name.gladsonsam.com`, resolves to Traefik, with Cloudflared
used for **ingress only**. Confirm this against the deployment before relying on it; the
exact production FQDN is operator-owned and must be confirmed, not guessed here. The
family-network egress proxy is a separate service and must not replace, shadow or reroute
the app's Traefik record or the Cloudflared ingress path. Ingress and egress have distinct
names, configs and lifecycles (section 3). This is a requirement to preserve existing
configuration, **not** a promise that app resolution stays available if DNS fails
(section 3).

[REQUIRED] DNS-loop avoidance, at minimum:

- The resolver's upstreams are explicit and never point back at a name it serves itself.
- The proxy/advertised endpoint name must not resolve to the resolver in a way that feeds
  the proxy's own queries back to itself; use distinct internal names/zones and document
  the intended resolution path before enablement.
- No changes to household DHCP, router or firewall settings are part of this work. Any
  DNS verification during a pilot is read-only and localhost/isolated; a before/after
  check must show the app name still reaches Traefik.

[PLANNED — UNVERIFIED] Concrete record names, upstream addresses and service bindings
are implementation decisions to be tested locally, not asserted here.

## 11. Limits to state accurately

These are inherent limits, not bugs to promise away:

- **Off-path clients** never traverse the pilot path; the pilot neither protects nor
  blocks them (section 3).
- **DoH/QUIC** and other encrypted or non-standard transports can bypass DNS-based or
  proxy-based handling; no claim of complete coverage.
- **VPNs** and **certificate pinning** can prevent interception even for an opted-in
  client; apps with their own trust stores may ignore a public CA added to the OS.
- **Shared TVs / shared accounts** defeat per-person attribution (section 6).
- A local CA/proxy is not a substitute for device-level controls, and this project has
  had no professional security review ([`README.md`](../README.md),
  [`SECURITY.md`](../SECURITY.md)).

## 12. Open followups (blocking any pilot)

1. Prove the CONNECT/interception path with an executable; settle the engine choice only
   then (Hudsucker raw-CONNECT bypass / Rama 0.4 evaluation, section 8).
2. Define and implement the CA tooling, custody, in-memory-only signer unlock, rotation,
   revocation and recovery procedure; verify no key ships in any artifact and that
   revocation includes trust-store removal/re-enrollment (section 4).
3. Specify the revision/ack wire contract, ack timeouts and worker-local durable LKG
   behavior; test saved vs applied vs stale ack and lost-ack reconciliation (no policy
   regression) explicitly (section 5).
4. Rehearse a restore of the full-database dump (which already includes same-DB
   controller/revision/ack tables) for this feature; cover the CA escrow, separate-host
   config and any external stores in the operator-controlled encrypted backup, or document
   re-enrollment-from-scratch recovery (section 7).
5. Specify controller/DNS/proxy lifecycles and DNS-loop-safe naming, treat the
   split-DNS/Traefik/Cloudflared topology as brief-sourced until verified, and define the
   read-only verification steps (sections 3 and 10); confirm the exact operator-owned FQDN.
6. Define the one-client pilot's client setting capture/restore evidence and bounded
   event retention window (sections 6 and 9).
