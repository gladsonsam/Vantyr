import { createContext, useContext } from "react";
import type { NetworkHousehold } from "@/api/types";

/** The household every Network screen is scoped to. Set by `NetworkLayout` once access is confirmed. */
export const NetworkScopeContext = createContext<NetworkHousehold | null>(null);

export function useNetworkHousehold(): NetworkHousehold {
  const household = useContext(NetworkScopeContext);
  if (!household) throw new Error("useNetworkHousehold must be used inside NetworkLayout");
  return household;
}
