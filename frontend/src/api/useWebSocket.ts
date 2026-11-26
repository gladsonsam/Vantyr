import { useEffect, useRef, useCallback, useEffectEvent } from "react";
import type { ViewerConnectionOptions } from "@/api/viewerConnection";
import { startViewerSocket } from "./liveViewerConnection";

export function useWebSocket({
  onMessage,
  onStatusChange,
  enabled = true,
}: ViewerConnectionOptions) {
  const connectionRef = useRef<ReturnType<typeof startViewerSocket> | null>(null);
  const receive = useEffectEvent(onMessage);
  const report = useEffectEvent(
    (status: Parameters<NonNullable<ViewerConnectionOptions["onStatusChange"]>>[0]) =>
      onStatusChange?.(status),
  );
  const send = useCallback((data: unknown) => connectionRef.current?.send(data), []);
  useEffect(() => {
    if (!enabled) {
      report("disconnected");
      return;
    }
    const connection = startViewerSocket(receive, report);
    connectionRef.current = connection;
    return () => {
      connection.stop();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [enabled]);
  return { send };
}
