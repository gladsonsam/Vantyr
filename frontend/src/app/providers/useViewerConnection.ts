import { createContext, useContext } from "react";
import type { ViewerConnection } from "@/api/viewerConnection";
import { useWebSocket } from "@/api/useWebSocket";

/**
 * Where the live event feed comes from. Defaults to the viewer WebSocket; the app root swaps in
 * another feed (the demo build's simulated fleet). The value must not change while mounted.
 */
export const ViewerConnectionContext = createContext<ViewerConnection>(useWebSocket);

export function useViewerConnection(): ViewerConnection {
  return useContext(ViewerConnectionContext);
}
