import { useCallback, type ReactNode } from "react";
import { Monitor } from "lucide-react";
import type { AgentInfo, DashboardRole } from "@/api/types";
import {
  capabilityAvailable,
  capabilityStatus,
} from "@/features/agent-detail/lib/agentCapabilities";
import { useDeviceModuleGrants } from "@/features/agent-settings/useDeviceModuleGrants";
import { useScreenStream } from "@/features/remote/hooks/useScreenStream";

/**
 * A view-only live picture of an agent's desktop: the same stream source the Live tab uses (the
 * demo build swaps in its fake desktop), with no input overlay, no control lease and no toolbar.
 * Fills its parent (give the parent a size and `position: relative`). `offline` is shown instead
 * of the picture while the device is offline or the stream can't run.
 */
export function LiveScreenPreview({
  agentId,
  online,
  agentInfo,
  dashboardRole,
  offline,
}: {
  agentId: string;
  online: boolean;
  agentInfo: AgentInfo | null | undefined;
  dashboardRole: DashboardRole | null;
  /** Shown over the empty stage when there is no picture (offline). */
  offline: ReactNode;
}) {
  const isOperator = dashboardRole === "operator" || dashboardRole === "admin";
  const blockedByRole = !isOperator && dashboardRole !== "viewer";
  const screenAvailable = capabilityAvailable(agentInfo, "screen_capture");
  const grants = useDeviceModuleGrants(agentId, isOperator && online);
  // The server refuses a stream the device hasn't granted, so don't start one that can only fail.
  const liveScreenOff = grants.granted("live_screen") === false;
  const streamEnabled = online && screenAvailable && !liveScreenOff && !blockedByRole;
  const onBeforeDisplay = useCallback(() => {}, []);
  const stream = useScreenStream({
    agentId,
    streamEnabled,
    online,
    blockedByRole,
    onBeforeDisplay,
    videoEnabled: capabilityStatus(agentInfo, "screen_h264") === "supported",
  });
  const { frames, streaming, error } = stream;
  const frameVisible = streamEnabled && streaming && !error;
  const showPicture = frameVisible || (streamEnabled && frames.selfLive);

  let message: string | null = null;
  if (!showPicture) {
    if (!online) message = null;
    else if (blockedByRole) message = "Your role can’t view this screen.";
    else if (!screenAvailable) message = "Screen capture isn’t available on this device.";
    else if (liveScreenOff) message = "Live screen is off on this device.";
    else if (error) message = "Couldn’t reach the screen.";
    else message = "Connecting to the screen…";
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden bg-[#0a0b0d]">
      {frames.render({
        layout: "embedded",
        streamEnabled,
        visible: frameVisible,
        transform: "none",
      })}
      {!showPicture ? (
        <div
          role="status"
          className="relative flex flex-col items-center gap-2 px-6 text-center text-sm text-muted-foreground"
        >
          <Monitor className="size-7" aria-hidden="true" />
          {message ?? offline}
        </div>
      ) : null}
    </div>
  );
}
