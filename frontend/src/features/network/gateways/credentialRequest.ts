import type { NetworkGatewayCommand } from "@/api/types";

export interface CredentialRequestValues {
  hours: string;
  readPolicy: boolean;
}

export const DEFAULT_CREDENTIAL_REQUEST: CredentialRequestValues = { hours: "24", readPolicy: true };

export function toCredentialBody(values: CredentialRequestValues) {
  const hours = Math.min(720, Math.max(1, Math.round(Number(values.hours)) || 24));
  const commands: NetworkGatewayCommand[] = values.readPolicy
    ? ["heartbeat", "read_policy"]
    : ["heartbeat"];
  return { expires_in_hours: hours, commands };
}

