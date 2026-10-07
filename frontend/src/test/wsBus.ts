import { createElement, type ReactNode } from "react";
import type { WsBus } from "@/api/wsBus";
import { WsBusContext } from "@/app/providers/useWsEvent";

/** Provide `bus` as the viewer WebSocket bus (what AgentsProvider does in the app); emit on it to simulate server events. */
export function withWsBus(node: ReactNode, bus: WsBus): ReactNode {
  return createElement(WsBusContext.Provider, { value: bus }, node);
}
