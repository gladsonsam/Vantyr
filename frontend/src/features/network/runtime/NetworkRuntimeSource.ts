import { createContext, useContext } from "react";
import type {
  Availability,
  Decision,
  DecisionQuery,
  DnsView,
  EventsPage,
  EventsQuery,
  NetworkOverview,
  PolicyEdit,
  PolicyView,
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
  proxy(): Promise<Availability<ProxyView>>;
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
  proxy: unavailable,
  events: unavailable,
};

export const NetworkRuntimeContext = createContext<NetworkRuntimeSource>(unavailableRuntime);

export function useNetworkRuntime(): NetworkRuntimeSource {
  return useContext(NetworkRuntimeContext);
}
