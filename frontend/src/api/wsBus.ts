import type { WsEvent, WsStatus } from "@/api/types";

type Listener<T> = (value: T) => void;

/** Fan-out for viewer WebSocket traffic: every parsed event and every connection-state change. */
export interface WsBus {
  emit(event: WsEvent): void;
  emitStatus(status: WsStatus): void;
  /** Returns the unsubscribe function. */
  subscribe(listener: Listener<WsEvent>): () => void;
  /** Returns the unsubscribe function. */
  subscribeStatus(listener: Listener<WsStatus>): () => void;
}

function channel<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit(value: T) {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (err) {
          // Keep one broken subscriber from starving the rest (as DOM event dispatch did).
          console.error("WebSocket listener failed:", err);
        }
      }
    },
    subscribe(listener: Listener<T>) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createWsBus(): WsBus {
  const events = channel<WsEvent>();
  const statuses = channel<WsStatus>();
  return {
    emit: events.emit,
    emitStatus: statuses.emit,
    subscribe: events.subscribe,
    subscribeStatus: statuses.subscribe,
  };
}
