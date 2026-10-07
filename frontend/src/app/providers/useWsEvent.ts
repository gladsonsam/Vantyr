import { createContext, useContext, useEffect, useRef } from "react";
import type { WsBus } from "@/api/wsBus";
import type { WsEvent, WsEventOf, WsEventType } from "@/api/types";

/** Provided by AgentsProvider, which owns the viewer WebSocket. */
export const WsBusContext = createContext<WsBus | null>(null);

/** The viewer WebSocket event bus, for effects that manage their own subscription lifetime. */
export function useWsBus(): WsBus {
  const bus = useContext(WsBusContext);
  if (!bus) throw new Error("useWsBus must be used inside AgentsProvider");
  return bus;
}

/**
 * Run `handler` for every viewer WebSocket event of the given type(s). The handler always sees the
 * latest render's values; the subscription itself lives as long as the component.
 */
export function useWsEvent<T extends WsEventType>(
  type: T | readonly T[],
  handler: (event: WsEventOf<T>) => void,
): void {
  const bus = useWsBus();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  const types = typeof type === "string" ? type : type.join(",");
  useEffect(() => {
    const wanted = new Set(types.split(","));
    return bus.subscribe((event: WsEvent) => {
      if (wanted.has(event.event)) handlerRef.current(event as WsEventOf<T>);
    });
  }, [bus, types]);
}
