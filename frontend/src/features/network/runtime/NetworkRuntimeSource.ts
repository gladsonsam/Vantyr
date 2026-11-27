import { createContext, useContext } from "react";
import type {
  Availability,
  ConnectionCheck,
  Decision,
  DecisionQuery,
  DnsCacheClearResult,
  DnsStats,
  DnsSettingsPatch,
  DnsUpdateOptions,
  IssueProxyCredentialInput,
  IssuedProxyCredential,
  ProxyAccessView,
  ProxyStatsQuery,
  DnsStatsQuery,
  DnsView,
  EventsPage,
  EventsQuery,
  NetworkOverview,
  PolicyEdit,
  PolicyView,
  ProxyInspection,
  ProxyStats,
  ProxyView,
} from "./types";

/**
 * Where the Network screens read gateway state, policy, DNS, proxy and events from. The server has no
 * API for these yet, so the real source reports "unavailable" and the screens say so. Only the demo
 * build supplies fixtures (through `DemoEnvironment`), and screens never branch on demo mode.
 */
export interface NetworkRuntimeSource {
  overview(): Promise<Availability<NetworkOverview>>;
  policy(): Promise<Availability<PolicyView>>;
  /** Saves a proposal. Saving is never enforcement: gateways must acknowledge a revision first. */
  editPolicy(edit: PolicyEdit): Promise<Availability<PolicyView>>;
  explainDecision(query: DecisionQuery): Promise<Availability<Decision>>;
  dns(): Promise<Availability<DnsView>>;
  dnsStats(query: DnsStatsQuery): Promise<Availability<DnsStats>>;
  /** Changes DNS settings. Like policy, a saved change is not proof a gateway is enforcing it. */
  updateDns(patch: DnsSettingsPatch, options?: DnsUpdateOptions): Promise<Availability<DnsView>>;
  /** Drops cached answers. Does not change the settings version. */
  clearDnsCache(): Promise<Availability<DnsCacheClearResult>>;
  proxy(): Promise<Availability<ProxyView>>;
  proxyStats(query: ProxyStatsQuery): Promise<Availability<ProxyStats>>;
  revokeProxyCredential(id: string): Promise<Availability<ProxyView>>;
  /** Proxy sign-in credentials and live sessions. Not worker tokens, setup grants or CA trust. */
  proxyAccess(): Promise<Availability<ProxyAccessView>>;
  /** The secret comes back once in the result and is never listed. */
  issueProxyCredential(
    input: IssueProxyCredentialInput,
  ): Promise<Availability<IssuedProxyCredential>>;
  endProxySession(id: string): Promise<Availability<ProxyAccessView>>;
  revokeAllForPerson(personId: string): Promise<Availability<ProxyAccessView>>;
  /** Turns HTTPS inspection on or off. Turning it on only starts trust setup; it is not "trusted" until devices say so. */
  setInspection(enabled: boolean): Promise<Availability<ProxyInspection>>;
  /** Asks the gateway to confirm it can see this device right now. */
  runCheck(deviceId: string, kind: "dns" | "proxy"): Promise<Availability<ConnectionCheck>>;
  events(query: EventsQuery): Promise<Availability<EventsPage>>;
}

const NOT_YET = "This server does not provide the Vantyr Network gateway API yet.";

const unavailable = async (): Promise<{ state: "unavailable"; reason: string }> => ({
  state: "unavailable",
  reason: NOT_YET,
});

/** The production source: honest about what the server cannot do yet. */
export const unavailableRuntime: NetworkRuntimeSource = {
  overview: unavailable,
  policy: unavailable,
  editPolicy: unavailable,
  explainDecision: unavailable,
  dns: unavailable,
  dnsStats: unavailable,
  updateDns: unavailable,
  clearDnsCache: unavailable,
  proxy: unavailable,
  proxyStats: unavailable,
  revokeProxyCredential: unavailable,
  proxyAccess: unavailable,
  issueProxyCredential: unavailable,
  endProxySession: unavailable,
  revokeAllForPerson: unavailable,
  setInspection: unavailable,
  runCheck: unavailable,
  events: unavailable,
};

export const NetworkRuntimeContext = createContext<NetworkRuntimeSource>(unavailableRuntime);

export function useNetworkRuntime(): NetworkRuntimeSource {
  return useContext(NetworkRuntimeContext);
}
