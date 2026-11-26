# Vantyr Network — BYOD onboarding roadmap

Status: required product milestone; the end-to-end flow is not implemented yet.
No network deployment or device trust-store changes are authorized by this plan.

## Responsibilities

- UniFi owns Wi-Fi admission, routing, firewall enforcement and router DHCP.
- The configured identity service owns accounts and credential verification.
  Vantyr reuses its existing OIDC integration rather than adding a password database.
- Vantyr owns filtering policy, device enrollment, scoped gateway/client credentials,
  proxy provisioning, inspection certificate lifecycle and connection verification.
- The device owner approves configuration and certificate trust when required by
  the operating system. Network enrollment grants no monitoring or remote control.

Wi-Fi authentication and HTTPS inspection are separate trust relationships. A
certificate accepted for an Enterprise Wi-Fi authentication server does not by
itself establish trust in the inspection authority or configure a web proxy.

## Administrator setup

1. Register DNS and Proxy workers using distinct scoped credentials.
2. Configure the network once to advertise the intended DNS endpoint; DHCP stays
   on the router. Proxy routing and any bypass-prevention rules remain explicit
   administrator-controlled steps, not automatic network changes.
3. Connect the identity provider and map authorized groups to Vantyr permissions.
4. Initialize a unique inspection authority with encrypted private-key custody.
   Generate certificates with maintained PKI libraries; export only public trust
   material through client-facing enrollment interfaces.
5. Choose inspection scope and temporary compatibility exceptions, then run a
   one-client verification before broader deployment.

## Device-owner flow

1. Open an enrollment URL or QR code and sign in with an existing account.
2. Register the device without treating its owner as its verified current user.
3. Obtain a short-lived enrollment grant and platform-appropriate setup package.
4. Apply proxy configuration and public certificate trust through explicit,
   reversible user approval; no private signing key leaves the signer.
5. Verify DNS, authenticated proxy routing and HTTPS inspection independently.
6. Provide sign-out, device revocation and configuration/trust removal.

The target is a short guided BYOD experience, including unmanaged personal
computers. Platform-specific installation steps must be tested and reported
accurately; there is no universal browser permission that configures every app.
Mobile companion applications remain deferred.

## Implementation sequence and acceptance evidence

- [ ] Gateway credential issuance, expiry, rotation, revocation and authenticated
  heartbeat API; missing or wrong credentials cannot impersonate a worker.
- [ ] Automatic unique CA initialization, encrypted recovery, public export,
  short-lived leaf issuance, rotation and retirement. Real certificate chain,
  hostname and expiry validation tests; no verification bypass.
- [ ] End-to-end Proxy inspection using the accepted signer, with scoped
  no-inspection exceptions and safe failure behavior.
- [ ] Authenticated enrollment service using the existing identity provider;
  single-use scoped grants bind device, person assertion, expiry and purpose.
- [ ] Reversible Windows/Linux provisioning via distinct opt-in permissions and
  setup packages. DNS-only devices need neither an inspection CA nor an agent.
- [ ] Verification canaries distinguish saved, reported, applied and verified;
  a downloaded certificate or successful login is not proof of traffic coverage.
- [ ] Shared-device sessions expire and return to the configured device default.
- [ ] Optional UniFi/RADIUS compatibility spike using an established RADIUS
  service, not a Vantyr-written EAP implementation. Confirm supported EAP methods,
  identity integration and accounting before claiming single-sign-in behavior.
- [ ] Recovery and revocation rehearsal: remove proxy settings and client trust,
  revoke credentials, preserve audit evidence and restore prior connectivity.

Inspection authority retirement does not itself remove certificates from client
trust stores. Public server-leaf renewal under an unchanged trusted authority is
separate from changing a root trust anchor. Record both operations accurately.

## Integration constraints

## Network-controller integration roadmap

UniFi is the first optional network adapter. The native DNS and Proxy workers
must remain usable without a controller integration. Credentials and live
controller testing are not available yet; initial acceptance uses documented
API contracts and isolated simulated controllers.

- [ ] Discover application version, site scope and supported API capabilities
  through the official versioned Network API; distinguish missing permissions,
  unsupported operations and unavailable controllers.
- [ ] Import bounded network/client observations, including IPv4/IPv6 and VLAN
  context, without treating MAC/IP associations as authenticated person identity.
- [ ] Build a deterministic setup plan for explicitly selected networks. Include
  current values, proposed DNS settings, dependencies, conflicts, verification
  steps and restoration values. Preserve split DNS and unrelated settings.
- [ ] Detect gateway-managed, switch-managed and externally managed networks;
  report manual steps when the installed API does not support a requested change.
- [ ] Exercise preview, stale-plan rejection, idempotency, verification and
  conflict-aware rollback against simulated controllers before live testing.
- [ ] Add explicitly authorized controller writes only for supported operations;
  never assume creating a network, changing VLANs or changing firewall policy is
  necessary to enable DNS. Router DHCP remains the DHCP service.
- [ ] Test read-only discovery with operator-provided credentials, then review a
  concrete network-specific plan before any live configuration changes.

Network credentials are distinct from gateway-worker and user credentials, and
are encrypted, redacted and scoped to the selected controller/site. Controller
HTTPS must be verified; an explicitly trusted local certificate is preferable
to disabling verification. Discovery is read-only by default. Unknown versions
or schema fields must never trigger speculative configuration writes.

Wi-Fi admission, proxy setup and inspection trust remain separate operations:
controller automation does not install a CA on BYOD devices. Drift detection
reports changes; unattended reconciliation requires a separate explicit opt-in.

Primary API guidance:
[official API overview](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
and [versioned Network API documentation](https://developer.ui.com/network/v10.6.109/gettingstarted).
The actual controller's documentation and capabilities are authoritative; the
linked example version is a scoping reference, not a minimum-version promise.

## Identity integration constraints

The existing identity provider's RADIUS protocol compatibility must be validated
against the chosen Wi-Fi authentication method. Username/password Wi-Fi login,
OIDC browser login and proxy authentication are different protocols even when
backed by the same accounts. Network association alone must not grant adult
policy privileges or prove the current person on a shared device.

Pinned applications, independent trust stores, encrypted DNS, QUIC, VPNs and
traffic outside the configured path remain explicit coverage limits. The product
must show what was verified rather than promise universal interception.
