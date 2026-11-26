import { useMemo, type ReactNode } from "react";
import { ViewerConnectionContext } from "@/app/providers/useViewerConnection";
import { NetworkRuntimeContext } from "@/features/network/runtime/NetworkRuntimeSource";
import { RecallEvidenceNoteContext } from "@/features/recall/hooks/useRecallEvidenceNote";
import { RemoteEnvironmentContext } from "@/features/remote/hooks/useRemoteEnvironment";
import { ScreenStreamSourceContext } from "@/features/remote/hooks/useScreenStreamSource";
import { demoRecallEvidenceNote, demoRemoteEnvironment } from "./adapters";
import { demoScreenStreamSource } from "./demoScreenStreamSource";
import { useDemoViewerConnection } from "./demoViewerConnection";
import { createDemoNetworkRuntime } from "./networkRuntime";

/** Everything the demo build injects into the app: the simulated desktop, fleet feed, terminal, clipboard, recall evidence and Network gateways. */
export function DemoEnvironment({ children }: { children: ReactNode }) {
  // One stateful fake gateway runtime per demo session, so saved policy edits persist across screens.
  const networkRuntime = useMemo(() => createDemoNetworkRuntime(), []);
  return (
    <ViewerConnectionContext.Provider value={useDemoViewerConnection}>
      <ScreenStreamSourceContext.Provider value={demoScreenStreamSource}>
        <RemoteEnvironmentContext.Provider value={demoRemoteEnvironment}>
          <RecallEvidenceNoteContext.Provider value={demoRecallEvidenceNote}>
            <NetworkRuntimeContext.Provider value={networkRuntime}>
              {children}
            </NetworkRuntimeContext.Provider>
          </RecallEvidenceNoteContext.Provider>
        </RemoteEnvironmentContext.Provider>
      </ScreenStreamSourceContext.Provider>
    </ViewerConnectionContext.Provider>
  );
}
