import type { NetworkConnectionKind } from "@/api/types";

export const CONNECTION_LABEL: Record<NetworkConnectionKind, string> = {
  agent: "Agent",
  dns: "DNS",
  proxy: "Proxy",
};

/** What each way of connecting can honestly tell Vantyr about who is using the device. */
export const IDENTITY_NOTE: Record<NetworkConnectionKind, string> = {
  agent: "Can tell who is signed in to the device, so a person can be verified.",
  dns: "Sees which device asked, not who. Without another connection, device defaults apply.",
  proxy: "Identifies a person only when they sign in to the proxy with their own credential.",
};
