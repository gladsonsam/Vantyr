/**
 * Vantyr Network inventory wire types (households, people, devices, assignments, connections).
 *
 * Hand-written from the inventory API contract until the server structs are exported to
 * `generated/`; swap these for re-exports when that lands. Household ids always travel in the URL
 * path, never in request bodies.
 */

export type NetworkGrantName = "network_admin" | "network_events";
// `network_enroll` (BYOD) exists server-side but is intentionally not modelled here yet.

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

/** Explicit desired assignment: a proposal for one gateway, never an applied/enforced claim. */
export interface NetworkDesiredPolicy {
  household_id: string;
  gateway_id: string;
  kind: NetworkGatewayKind;
  revision: number;
  assigned_by: string | null;
  assigned_at: string;
}
