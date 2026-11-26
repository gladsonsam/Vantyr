/**
 * Vantyr Network inventory wire types (households, people, devices, assignments, connections).
 *
 * Hand-written from the inventory API contract until the server structs are exported to
 * `generated/`; swap these for re-exports when that lands. Household ids always travel in the URL
 * path, never in request bodies.
 */

/**
 * `network_enroll` lets a person enroll their own devices (BYOD) once an administrator has mapped
 * them to a person. It grants no events, inventory or policy permissions.
 */
export type NetworkGrantName = "network_admin" | "network_events" | "network_enroll";

export interface NetworkHousehold {
  id: string;
  name: string;
  timezone: string;
  is_default: boolean;
  created_at: string;
}

export interface NetworkPerson {
  id: string;
  household_id: string;
  display_name: string;
  is_default_profile: boolean;
  note: string | null;
  created_at: string;
}

/** A device belongs to the household, not to a person; people are linked through assignments. */
export interface NetworkDevice {
  id: string;
  household_id: string;
  canonical_key: string;
  label: string;
  device_type: NetworkDeviceType;
  /** Deliberately shared inside the household (not global ownership). */
  shared: boolean;
  created_at: string;
  updated_at: string;
}

export interface NetworkAssignment {
  id: string;
  household_id: string;
  person_id: string;
  device_id: string;
  /** Linked Vantyr agent, when the device runs one. */
  agent_id: string | null;
  active: boolean;
  role: NetworkAssignmentRole;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `status`, `capabilities`, `provenance` and the timestamps are reported, unverified observations.
 * A connection is about a device; the assignment (person) and enrolled agent links are optional.
 */
export interface NetworkConnection {
  id: string;
  household_id: string;
  device_id: string;
  assignment_id: string | null;
  enrolled_agent_id: string | null;
  kind: NetworkConnectionKind;
  provenance: NetworkProvenance;
  capabilities: string[];
  status: NetworkConnectionStatus;
  observed_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface NetworkAgentEnrollment {
  household_id: string;
  agent_id: string;
  enrolled_at: string;
}

export interface NetworkGrant {
  household_id: string;
  user_id: string;
  grant_name: NetworkGrantName;
  granted_at: string;
}

export const NETWORK_DEVICE_TYPES = [
  "computer",
  "phone",
  "tablet",
  "router",
  "switch",
  "ap",
  "tv",
  "iot",
  "other",
  "unknown",
] as const;
export type NetworkDeviceType = (typeof NETWORK_DEVICE_TYPES)[number];

export const NETWORK_ASSIGNMENT_ROLES = [
  "owner",
  "member",
  "guest",
  "managed",
  "unknown",
] as const;
export type NetworkAssignmentRole = (typeof NETWORK_ASSIGNMENT_ROLES)[number];

export const NETWORK_CONNECTION_KINDS = ["agent", "dns", "proxy"] as const;
export type NetworkConnectionKind = (typeof NETWORK_CONNECTION_KINDS)[number];

export const NETWORK_PROVENANCES = [
  "manual",
  "agent",
  "dns",
  "proxy",
  "import",
] as const;
export type NetworkProvenance = (typeof NETWORK_PROVENANCES)[number];

export const NETWORK_CONNECTION_STATUSES = [
  "unknown",
  "active",
  "inactive",
  "stale",
  "error",
  "revoked",
] as const;
export type NetworkConnectionStatus =
  (typeof NETWORK_CONNECTION_STATUSES)[number];

/** A field that can be left alone (omitted), cleared (`null`) or set. */
export type Patch<T> = T | null | undefined;

// ─── Gateways (DNS / Proxy workers) ──────────────────────────────────────────

export const NETWORK_GATEWAY_KINDS = ["dns", "proxy"] as const;
export type NetworkGatewayKind = (typeof NETWORK_GATEWAY_KINDS)[number];

/** Commands a worker credential can be scoped to. Heartbeat-only unless `read_policy` is requested. */
export const NETWORK_GATEWAY_COMMANDS = ["heartbeat", "read_policy"] as const;
export type NetworkGatewayCommand = (typeof NETWORK_GATEWAY_COMMANDS)[number];

/** Capabilities a worker may report (server allowlist). */
export type NetworkGatewayCapability =
  "dns" | "proxy" | "heartbeat" | "config-read";

/** `capabilities` and `last_seen_at` are reported, unverified observations, not enforcement state. */
export interface NetworkGateway {
  id: string;
  household_id: string;
  kind: NetworkGatewayKind;
  label: string;
  enabled: boolean;
  capabilities: string[];
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Metadata only. The secret and its hash never leave the one-time issuance response. */
export interface NetworkGatewayCredential {
  id: string;
  household_id: string;
  gateway_id: string;
  kind: NetworkGatewayKind;
  audience: string;
  allowed_commands: NetworkGatewayCommand[];
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  issued_at: string;
  rotated_from: string | null;
}

/** Shown exactly once on issue / rotate: `token` cannot be read again. */
export interface NetworkGatewayCredentialIssued {
  credential_id: string;
  token: string;
  expires_at: string;
}

export interface NetworkGatewayCredentialRequest {
  /** 1..=720, server default 24. */
  expires_in_hours?: number;
  /** Omitted means heartbeat-only; `read_policy` is never added implicitly. */
  commands?: NetworkGatewayCommand[];
}

/**
 * An append-only heartbeat report from a worker. Everything here is an UNVERIFIED observation:
 * `applied_revision` is what the worker claims, not proof of enforcement. `verified` and `enforced`
 * are always false server-side and exist so a report is never mistaken for an acknowledgement.
 */
export interface NetworkGatewayReport {
  id: number;
  household_id: string;
  gateway_id: string;
  credential_id: string;
  reported_at: string;
  observed_at: string;
  capabilities: string[];
  desired_revision: string | null;
  applied_revision: string | null;
  failure: string | null;
  verified: false;
  enforced: false;
}

/** Offset page window shared by the list endpoints (`limit` 1..=1000, `offset` 0..=100000). */
export interface NetworkPageParams {
  limit?: number;
  offset?: number;
}

// ─── Household audit ─────────────────────────────────────────────────────────

/** Household-scoped audit row (newest first). Requires `network_admin` on the household. */
export interface NetworkAuditRow {
  id: number;
  ts: string;
  household_id: string;
  actor: string;
  client_ip: string | null;
  action: string;
  status: string;
  detail: Record<string, unknown>;
}

/**
 * Filters for the household audit. `action` and `actor` are EXACT stored strings (1..=128 chars,
 * no control characters). `from`/`to` are RFC3339 and inclusive; `from` after `to` is a 400.
 * `limit` 1..=1000 (server default 50), `offset` 0..=100000.
 */
export interface NetworkAuditFilters extends NetworkPageParams {
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
}

/** The audit page. `rows` keeps its old shape; the rest makes paging safe under inserts. */
export interface NetworkAuditResponse {
  rows: NetworkAuditRow[];
  /** Rows matching the filters, across all pages. */
  total: number;
  has_more: boolean;
  next_offset: number | null;
  /** More rows exist but are beyond the offset cap: narrow the filters instead of paging. */
  pagination_limited: boolean;
}

// ─── Policy (versioned, saved proposals only) ────────────────────────────────

export type NetworkPolicyEffect = "allow" | "deny";

/** Externally tagged, snake_case. The server accepts only domain_suffix and host_exact for now. */
export type NetworkPolicyMatcher =
  | { domain_suffix: string }
  | { host_exact: string }
  | { category: string }
  | "any";

/** Weekdays Monday = 0 .. Sunday = 6; minutes from local midnight (0..=1440). */
export interface NetworkPolicySchedule {
  weekdays: number[];
  start_minute: number;
  end_minute: number;
  timezone: string;
}

export interface NetworkPolicyRule {
  id: string;
  effect: NetworkPolicyEffect;
  matcher: NetworkPolicyMatcher;
  schedule: NetworkPolicySchedule | null;
  reason: string;
}

/**
 * What an admin submits. The server assigns household, revision and publish time. Person rules and
 * exceptions are refused for now, and the default effect must be `deny`.
 */
export interface NetworkPolicyDraft {
  /** Deny rules only. */
  baseline: NetworkPolicyRule[];
  device_profiles: Record<string, NetworkPolicyRule[]>;
  default_effect: "deny";
  timezone: string;
  stale_after_secs: number;
  event_retention_secs: number;
  /** Optimistic-concurrency token: the latest revision the editor was based on. */
  expected_revision?: number;
}

/** A saved proposal. Never applied or enforced anywhere by saving. */
export interface NetworkPolicySaved {
  revision: number;
  body_sha256: string;
  status: "saved";
}

/** Metadata of one stored revision (the policy body is not served to the dashboard). */
export interface NetworkPolicyVersion {
  household_id: string;
  revision: number;
  schema_version: number;
  source_kind: string;
  rolled_back_from_revision: number | null;
  published_at: string;
  published_by: string | null;
  body_sha256: string;
  body_bytes: number;
}

/**
 * The core policy body exactly as stored (vantyr_network_policy::Policy). Rules and settings live
 * here; revision/provenance metadata lives on the enclosing `NetworkPolicyView`.
 */
export interface NetworkPolicyBody {
  household_id: string;
  revision: number;
  /** Non-overridable safety rules; deny only. */
  baseline: NetworkPolicyRule[];
  /** Keyed by device profile id; a profile may be empty. */
  device_profiles: Record<string, NetworkPolicyRule[]>;
  /** Keyed by person id. Not editable in the composer yet. */
  person_rules: Record<string, NetworkPolicyRule[]>;
  /** Not editable in the composer yet. */
  exceptions: NetworkPolicyException[];
  default_effect: NetworkPolicyEffect;
  timezone: string;
  stale_after_secs: number;
  event_retention_secs: number;
  published_at: string;
}

export type NetworkPolicyActionKind = "dns" | "http" | "app" | "screen_time";

/** Externally tagged, snake_case. */
export type NetworkPolicyExceptionScope =
  | { device: string }
  | { person: string }
  | { device_action: { device_id: string; action: NetworkPolicyActionKind } };

export interface NetworkPolicyException {
  id: string;
  approver: string;
  approved_at: string;
  scope: NetworkPolicyExceptionScope;
  rules: NetworkPolicyRule[];
  expires_at: string;
  revoked_at: string | null;
}

/**
 * One stored revision with its body. Metadata is on this object, the rules and settings on
 * `.policy`. A stored revision is a saved proposal: never evidence of what any gateway applied.
 */
export interface NetworkPolicyView extends NetworkPolicyVersion {
  policy: NetworkPolicyBody;
}

/** `GET policies/current` and `GET policies/{revision}`. `current` is the highest stored revision. */
export interface NetworkPolicyViewResponse {
  policy: NetworkPolicyView;
}

/** Revision provenance in a diff. It is never part of the content comparison. */
export interface NetworkPolicyDiffProvenance {
  revision: number;
  schema_version: number;
  source_kind: string;
  rolled_back_from_revision: number | null;
  published_at: string;
  body_sha256: string;
}

/** `device_profile_ids` carries sorted names (including empty profiles) as string arrays. */
export type NetworkPolicySettingField =
  | "default_effect"
  | "timezone"
  | "stale_after_secs"
  | "event_retention_secs"
  | "device_profile_ids"
  | "person_rules"
  | "exceptions";

export interface NetworkPolicySettingChange {
  field: NetworkPolicySettingField | (string & {});
  before: unknown;
  after: unknown;
}

export type NetworkPolicyRuleChangeKind = "added" | "removed" | "changed";

export interface NetworkPolicyRuleChange {
  /** `baseline` or `profile:<name>`. */
  scope: string;
  id: string;
  change: NetworkPolicyRuleChangeKind;
  before: NetworkPolicyRule | null;
  after: NetworkPolicyRule | null;
}

/** Counts describe the FULL diff, even when `rules` was truncated. */
export interface NetworkPolicyDiffCounts {
  added_rules: number;
  removed_rules: number;
  changed_rules: number;
  changed_settings: number;
  total_rules_from: number;
  total_rules_to: number;
}

export interface NetworkPolicyDiff {
  household_id: string;
  from: NetworkPolicyDiffProvenance;
  to: NetworkPolicyDiffProvenance;
  /** False for an identical-content rollback even though revision and digest differ. */
  content_changed: boolean;
  settings: NetworkPolicySettingChange[];
  rules: NetworkPolicyRuleChange[];
  counts: NetworkPolicyDiffCounts;
  /** True when `rules` is incomplete; `omitted_changes` says how many were left out. */
  truncated: boolean;
  omitted_changes: number;
}

export interface NetworkPolicyDiffResponse {
  diff: NetworkPolicyDiff;
}

/** Explicit desired assignment: a proposal for one gateway, never an applied/enforced claim. */
export interface NetworkDesiredPolicy {
  household_id: string;
  gateway_id: string;
  kind: NetworkGatewayKind;
  revision: number;
  assigned_by: string | null;
  assigned_at: string;
}


// ─── BYOD enrollment ─────────────────────────────────────────────────────────

/** Admin-created mapping of one existing dashboard user to one existing person. */
export interface NetworkBinding {
  id: string;
  dashboard_user: string;
  person_id: string;
  generation: number;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
  /** Dashboard login name and display name of the mapped user, and the mapped person's name. */
  dashboard_username: string;
  dashboard_display_name: string;
  person_display_name: string;
}

export interface NetworkDeviceAuthorization {
  id: string;
  binding_id: string;
  device_id: string;
  generation: number;
  status: string;
  authorized_by: string | null;
  created_at: string;
}

export interface NetworkDeviceAuthorizationPage {
  enrollments: NetworkDeviceAuthorization[];
  limit: number;
  offset: number;
  returned: number;
  /** True when the page was full: more rows may exist. */
  truncated: boolean;
}

/** Device types a person may self-register (the server rejects anything else). */
export const NETWORK_SELF_DEVICE_TYPES = [
  "computer",
  "phone",
  "tablet",
  "tv",
  "iot",
  "other",
] as const;
export type NetworkSelfDeviceType = (typeof NETWORK_SELF_DEVICE_TYPES)[number];

export const NETWORK_SETUP_PURPOSES = ["proxy_setup", "dns_setup"] as const;
export type NetworkSetupPurpose = (typeof NETWORK_SETUP_PURPOSES)[number];

/** Setup grant lifetime bounds in seconds (the server rejects, never clamps). */
export const NETWORK_GRANT_MIN_SECS = 60;
export const NETWORK_GRANT_MAX_SECS = 600;

export interface NetworkOwnDevice {
  id: string;
  label: string;
  /** Free text from the server; self-registered devices use `NetworkSelfDeviceType`. */
  device_type: string;
  shared: boolean;
  enrollment_id: string;
  enrollment_status: string;
}

export interface NetworkOwnGrant {
  id: string;
  device_id: string;
  purpose: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface NetworkOwnSession {
  id: string;
  device_id: string;
  purpose: string;
  verification_method: string;
  verified_at: string;
  expires_at: string;
  ended_at: string | null;
  person_display_name: string;
}

/** One household and person the signed-in user is bound to. `GET /network/enrollment-contexts`. */
export interface NetworkEnrollmentContext {
  household_id: string;
  household_name: string;
  person_id: string;
  person_display_name: string;
  binding_id: string;
  generation: number;
}

export interface NetworkEnrollmentContextPage {
  contexts: NetworkEnrollmentContext[];
  count: number;
  total: number;
  has_more: boolean;
  next_offset: number | null;
  pagination_limited: boolean;
}

export interface NetworkEnrolledDevice {
  ok: boolean;
  device_id: string;
  status: "enrolled";
  network_coverage: "unverified";
}

/** The one-time issuance receipt. `secret` is never returned again; never persist it. */
export interface NetworkSetupGrantIssued {
  grant_id: string;
  secret: string;
  household_id: string;
  device_id: string;
  purpose: NetworkSetupPurpose;
  expires_at: string;
  status: "issued";
  setup: "pending_setup";
  network_coverage: "unverified";
  note: string;
}

export interface NetworkSetupGrantConsume {
  grant_id: string;
  secret: string;
  purpose: NetworkSetupPurpose;
  device_id: string;
}

export interface NetworkVerifiedSession {
  session_id: string;
  household_id: string;
  device_id: string;
  purpose: NetworkSetupPurpose;
  verification_method: "oidc_session";
  verified_at: string;
  expires_at: string;
  status: "verified_session";
  network_coverage: "unverified_runtime_identity";
  note: string;
}

export interface NetworkSessionEndResult {
  ok: boolean;
  grants_revoked: number;
  /** Server wording of what was ended, shown verbatim. */
  scope: string;
}
