import type { NetworkGatewayCommand, NetworkGatewayKind } from "@/api/types";

export interface CredentialRequestValues {
  hours: string;
  readPolicy: boolean;
  /** DNS gateways only. */
  readDnsManagement: boolean;
  /** DNS gateways only. */
  reportDnsStatus: boolean;
}

export const DEFAULT_CREDENTIAL_REQUEST: CredentialRequestValues = {
  hours: "24",
  readPolicy: true,
  readDnsManagement: false,
  reportDnsStatus: false,
};

/** Pre-checks the scopes a previous credential held. Never upgrades: only what it had. */
export function valuesFromCommands(
  commands: readonly NetworkGatewayCommand[],
): CredentialRequestValues {
  return {
    hours: "24",
    readPolicy: commands.includes("read_policy"),
    readDnsManagement: commands.includes("read_dns_management"),
    reportDnsStatus: commands.includes("report_dns_status"),
  };
}

/** Heartbeat is always sent; the DNS scopes are only ever requested for DNS gateways. */
export function toCredentialBody(values: CredentialRequestValues, kind: NetworkGatewayKind = "dns") {
  const hours = Math.min(720, Math.max(1, Math.round(Number(values.hours)) || 24));
  const commands: NetworkGatewayCommand[] = ["heartbeat"];
  if (values.readPolicy) commands.push("read_policy");
  if (kind === "dns") {
    if (values.readDnsManagement) commands.push("read_dns_management");
    if (values.reportDnsStatus) commands.push("report_dns_status");
  }
  return { expires_in_hours: hours, commands };
}

export const DNS_SCOPE_COMMANDS: readonly NetworkGatewayCommand[] = [
  "read_dns_management",
  "report_dns_status",
];
