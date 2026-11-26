import type {
  NetworkAssignmentRole,
  NetworkConnectionKind,
  NetworkConnectionStatus,
  NetworkDeviceType,
} from "@/api/types";

export const TYPE_LABEL: Record<NetworkDeviceType, string> = {
  computer: "Computer",
  phone: "Phone",
  tablet: "Tablet",
  router: "Router",
  switch: "Switch",
  ap: "Access point",
  tv: "TV",
  iot: "Smart device",
  other: "Other",
  unknown: "Unknown",
};

export const ROLE_LABEL: Record<NetworkAssignmentRole, string> = {
  owner: "Owner",
  member: "Member",
  guest: "Guest",
  managed: "Managed",
  unknown: "Unknown",
};

export const KIND_LABEL: Record<NetworkConnectionKind, string> = {
  dns: "DNS",
  proxy: "Proxy",
  agent: "Agent link",
};

export const STATUS_TONE: Record<NetworkConnectionStatus, { text: string; label: string }> = {
  active: { text: "text-success", label: "Active (reported)" },
  inactive: { text: "text-muted-foreground", label: "Inactive" },
  stale: { text: "text-warning", label: "Stale" },
  error: { text: "text-destructive", label: "Error" },
  revoked: { text: "text-destructive", label: "Revoked" },
  unknown: { text: "text-muted-foreground", label: "Unknown" },
};
