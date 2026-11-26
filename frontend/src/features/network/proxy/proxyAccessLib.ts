import type { ProxyCredentialView } from "@/features/network/runtime/types";

export const EXPIRY_OPTIONS = [
  { hours: 8, label: "8 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
] as const;

export type CredentialStatus = "active" | "revoked" | "expired";

export function credentialStatus(
  credential: ProxyCredentialView,
  now: number = Date.now(),
): CredentialStatus {
  if (credential.revoked) return "revoked";
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() <= now) return "expired";
  return "active";
}

export const STATUS_TEXT: Record<CredentialStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "text-success" },
  revoked: { label: "Revoked", className: "text-muted-foreground" },
  expired: { label: "Expired", className: "text-warning" },
};

export function suggestLabel(person: string | undefined, device: string | undefined): string {
  if (!person) return "";
  return device ? `${person} on ${device}` : person;
}

/** Credentials for one device: matched by device id first, then by label (the demo keeps both). */
export function credentialsForDevice(
  credentials: ProxyCredentialView[],
  deviceId: string | null,
  label: string,
): ProxyCredentialView[] {
  const byId = deviceId ? credentials.filter((c) => c.deviceId === deviceId) : [];
  if (byId.length > 0) return byId;
  return credentials.filter((c) => c.label === label);
}

export const PROXY_CREDENTIAL_HELP =
  "A proxy sign-in credential lets one person sign in through the Vantyr proxy, so requests can be tied to them. It is not a gateway worker token (how a gateway talks to Vantyr), not a BYOD setup grant (how a device is enrolled), and not HTTPS-inspection CA trust (what lets the proxy read encrypted traffic).";
