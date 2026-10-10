import type { ReactNode } from "react";
import { ViewerConnectionContext } from "@/app/providers/useViewerConnection";
import { RecallEvidenceNoteContext } from "@/features/recall/hooks/useRecallEvidenceNote";
import { RemoteEnvironmentContext } from "@/features/remote/hooks/useRemoteEnvironment";
import { ScreenStreamSourceContext } from "@/features/remote/hooks/useScreenStreamSource";
import { demoRecallEvidenceNote, demoRemoteEnvironment } from "./adapters";
import { demoScreenStreamSource } from "./demoScreenStreamSource";
import { useDemoViewerConnection } from "./demoViewerConnection";

/** Everything the demo build injects into the app: the simulated desktop, fleet feed, terminal, clipboard and recall evidence. */
export function DemoEnvironment({ children }: { children: ReactNode }) {
  return (
    <ViewerConnectionContext.Provider value={useDemoViewerConnection}>
      <ScreenStreamSourceContext.Provider value={demoScreenStreamSource}>
        <RemoteEnvironmentContext.Provider value={demoRemoteEnvironment}>
          <RecallEvidenceNoteContext.Provider value={demoRecallEvidenceNote}>{children}</RecallEvidenceNoteContext.Provider>
        </RemoteEnvironmentContext.Provider>
      </ScreenStreamSourceContext.Provider>
    </ViewerConnectionContext.Provider>
  );
}
