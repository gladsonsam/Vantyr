# Authenticated BYOD enrollment backend

Neutral contract note for the additive slice in migration `0078` and
`server/src/network/enroll_*`. Migration `0073`–`0077` are unchanged.

## Authorization model

- `network_enroll` is a new, independent, household-scoped grant. It is not
  implied by platform roles, `network_admin` or `network_events`, and it does
  not authorize inventory, policy, grant management or event reads. No grant is
  inserted by the migration.
- An admin with `network_admin` explicitly maps an existing `dashboard_users`
  row to an existing `network_persons` row in the same household. The mapping
  is unique per household/user and records the acting admin. Re-mapping or
  revoking bumps a generation that invalidates all previously issued objects.
- Self-service identity always comes from the OIDC session `AuthUser`. Bodies
  cannot carry a person id, user id, household id, device UUID, key, MAC or IP
  claim. No owner is inferred from network association.

## Flow

1. The user self-registers a new BYOD device (server-generated canonical key),
   or an admin pre-authorizes an existing household device to the binding.
2. The user requests a grant with a purpose from `proxy_setup` / `dns_setup`
   and a server-bounded lifetime of 60–600 seconds. A 256-bit random secret is
   returned once; only its SHA-256 digest is stored in a new credential family.
3. The grant is consumed atomically with the authenticated session and CSRF.
   Scope, generation, expiry, device authorization and constant-time proof are
   checked inside one household lock. Failed checks record a bounded outcome
   code and do not burn the grant.
4. A successful consume creates one time-bounded verified session (maximum
   eight hours). One live session per device is allowed; switching requires
   ending the previous session.

Self-revocation, network logout, device-end and admin binding-revoke invalidate
grants and sessions in the same transaction.

## Scope boundaries

This slice issues scoped receipts and records verified sessions. It does not
deliver proxy credentials, DNS/proxy account propagation, CA export, client
trust installation, provisioning scripts or router/DHCP changes. Receipts say
so explicitly (`pending_setup`, `unverified`, `unverified_runtime_identity`):
an OIDC session is not proof of a person on a shared device or of network
coverage. Agent tokens, module grants, Recall/control state and gateway-worker
credentials are untouched.

Attempt outcomes and retired grants/sessions are bounded by age and per-
household count, both on write and via exported sweep functions. No secret,
digest or free-text claim is written to audit or error text.
