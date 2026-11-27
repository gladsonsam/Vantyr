# Accepted DNS management UI contract

Accepted backend: `910515ef` on `feat/network-hermes-continuation`.
Combined validation: 28 server tests, 70 worker/listener/SafeSearch tests,
five converter tests, then strict family-dns/network-runtime all-target clippy.
This accepts HTTP settings/cache-clear integration, not household deployment or
an already validated frontend. All paths below include the existing `/api` prefix.

| Method and route | Ordered DTO and source | Authorization | Result and conflict semantics |
|---|---|---|---|
| GET `/api/network/households/{hid}/dns/management` | `ManagementView`, `server/src/network/dns_management_dto.rs:476`: `desired` nullable, `delivery` array, `supported`. `DesiredView:454`: `config_version`, `body_sha256`, `config`, `created_at`, `updated_at`, `updated_by` nullable. | Session and explicit household `network_admin`. | Desire and delivery evidence only; saving does not prove worker application. No desired config is `desired:null`. |
| PATCH same route | `PatchBody:232`: `expected_config_version`, `operations`; `PatchOperation:241`. Runtime operations are `{op:"set_runtime_settings",runtime:RuntimeSettingsDto}` and `{op:"reset_runtime_settings"}`. | Same grant plus existing CSRF middleware. | `PatchResult:483` is flattened: `changed`, `desired`, `delivery`, `supported`. Expected version 0 creates; otherwise exact current version required. Stale 409: `expected_config_version is stale; reload the desired config`. Reload and preserve the draft for deliberate resubmission. Reset restores current defaults and retains `runtime`. |
| POST `/api/network/households/{hid}/dns/cache/clear` | `CacheClearBody:501`: `expected_config_version`. `CacheClearResult:507`: `clear_seq`, `config_version`, `expires_at`, `created`, `cooldown_secs`. | Session, household `network_admin`, CSRF. | Same stale-CAS 409; 404 if no saved DNS config. Request queues a command; it does not prove a cache was cleared. Cooldown 60 seconds; token lifetime 600 seconds. Within cooldown returns the existing token with `created:false`, possibly targeting the previous config version. Respect returned version and expiry. |
| GET `/api/network/households/{hid}/dns/status` | `StatusView:595`: `desired_version` nullable, `gateways`. `GatewayStatusView:585`: `gateway_id`, nullable `delivered_version`, nullable `reported_version`, nullable `status`, nullable `cache_clear`. `CacheClearView:519`: `clear_seq`, `config_version`, `requested_at`, `expires_at`, nullable `delivered_at`, `attempted_at`, `acked_at`. | Session plus explicit household `network_admin` OR `network_events`. | Poll for the exact sequence and config version returned by POST. Requested, delivered, attempted and acknowledged are distinct timestamps. Null means no evidence of that step. Expiry without acknowledgement is not success. A new cycle replaces previous per-gateway delivery/ack state. |

All structs use the single current contract. Remove prior `schema_version`
metadata and use required `runtime`; do not keep a second DTO, dispatch path,
fallback reader or inferred conversion in the frontend. Existing list/catalog/
selected-service operations remain unchanged. Unknown fields are rejected.

`ManagementConfig:216` serialization order is `sources`, `catalog` nullable,
`selected_services`, `runtime` required. The server owns the digest and versions;
the UI need not reproduce canonical bytes or hashes.

`RuntimeSettingsDto:204` contains `cache`, then `deny`:

- `CacheSettingsDto:154`: `enabled` boolean (default true), `max_entries`
  integer (default 4096, range 0..65536 cached responses), then nullable
  `positive_min_ttl_secs`, `positive_max_ttl_secs`, `negative_min_ttl_secs`,
  `negative_max_ttl_secs`. Each non-null bound is 1..86400 seconds; minimum
  must not exceed maximum. Null means the resolver default. Disabled or zero
  entries disables caching; this is not a byte capacity or live entry count.
- `DenySettingsDto:188` is tagged by `mode`: `nxdomain` (default), `refused`,
  or `sinkhole` with nullable literal `ipv4`, nullable literal `ipv6`, and
  `ttl_secs` (default 60, range 1..86400). Sinkhole requires at least one
  correctly matched address family. Send the whole supported runtime object
  for replacement; this is not a patch of individual nested fields.

JSON/semantic validation returns 400; request bodies over 32 KiB return 413.
Saved canonical config is limited to 16 KiB. Other 409s include conflicting
source IDs and exhausted counters: do not treat every 409 as stale CAS.
No typed machine-readable error discriminator is added by this slice.

The worker's same-version/different-digest fence is not an admin CAS error or
an interactive conversion API. Applied failures appear in gateway status;
never silently reset settings, retry a conversion, or label the gateway verified.
Existing installations use the explicit stopped-writer procedure in
`server/scripts/README.offline0085.md`, including evidence backup and bundle
conversion. Migration/checksum handling stays outside the browser UI.

The worker clears once per live sequence/version and retries an unacknowledged
report while its token is live. Failed application of a newer config does not
replay an old clear acknowledgement or block status reporting. Clearing does
not advance bundle generation; timestamps are preserved rather than refreshed
on restart. There is no returned entries-cleared count.

SafeSearch, exact rewrites, per-device settings, upstream/listener/trust/path
settings, hosts files, bogus-address controls and other local runtime features
have no management fields in this contract. `supported.safe_search`, rate-limit,
retention, stale-serving and verification flags remain false. These local
capabilities must remain unavailable in real UI controls until separately wired.
Real DNS events/statistics use their existing endpoints, not these flags.

Fixtures: `tests/network-contracts/dns-management/read.json` and `report.json`.
Real server/worker regressions: `server/src/network/dns_management_e2e_tests.rs`,
including full upgrade, settings/reset/clear flow and failed-apply/new-clear
regression. Frontend still requires typecheck/lint, source review and honest
real-HTTP validation; no frontend tests or browser runs are authorized here.

Frontend implementation through `dde41e93` on `feat/network-ui-hermes` is
source-reviewed within the DNS settings/cache-clear slice. Typecheck, lint and
format checks passed as reported by its owner; no real-server or browser pass
is claimed. The POST token drives polling even before gateway delivery exists;
expiry schedules a final status fetch, and one acknowledgement does not imply
that every gateway has cleared. Draft/editor state remounts on source/household
changes. Remaining limits: a page reload forgets the browser's pending token,
expiry uses the client clock, and live tokens poll every five seconds until
expiry. Existing per-gateway evidence remains authoritative after reload.
