/**
 * Vantyr Network inventory wire types (households, people, devices, assignments, connections).
 *
 * Hand-written from the inventory API contract until the server structs are exported to
 * `generated/`; swap these for re-exports when that lands. Household ids always travel in the URL
 * path, never in request bodies.
 */

export type NetworkGrantName = "network_admin" | "network_events";

export interface NetworkHousehold {
  id: string;
  name: string;
  is_default: boolean;
  created_at: string;
}

export interface NetworkPerson {
  id: string;
  household_id: string;
  display_name: string;
  note: string | null;
  created_at: string;
}

export interface NetworkDevice {
  id: string;
  canonical_key: string;
  label: string;
  device_type: NetworkDeviceType;
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
  role: NetworkAssignmentRole;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface NetworkConnection {
  id: string;
  household_id: string;
  assignment_id: string;
  kind: NetworkConnectionKind;
  provenance: NetworkProvenance;
  capabilities: string[];
  status: NetworkConnectionStatus;
  observed_at: string | null;
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

export const NETWORK_ASSIGNMENT_ROLES = ["owner", "member", "guest", "managed", "unknown"] as const;
export type NetworkAssignmentRole = (typeof NETWORK_ASSIGNMENT_ROLES)[number];

export const NETWORK_CONNECTION_KINDS = ["agent", "dns", "proxy"] as const;
export type NetworkConnectionKind = (typeof NETWORK_CONNECTION_KINDS)[number];

export const NETWORK_PROVENANCES = ["manual", "agent", "dns", "proxy", "import"] as const;
export type NetworkProvenance = (typeof NETWORK_PROVENANCES)[number];

export const NETWORK_CONNECTION_STATUSES = [
  "unknown",
  "active",
  "inactive",
  "stale",
  "error",
] as const;
export type NetworkConnectionStatus = (typeof NETWORK_CONNECTION_STATUSES)[number];

/** A field that can be left alone (omitted), cleared (`null`) or set. */
export type Patch<T> = T | null | undefined;
