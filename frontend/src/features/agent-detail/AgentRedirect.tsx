import { Navigate, useLocation, useParams } from "react-router-dom";
import { LoadContent } from "@/app/shell/AppShell";
import { useDeviceRows } from "@/features/devices/hooks/useDeviceRows";
import { deviceHrefForAgent, deviceKeyForAgent } from "@/features/devices/lib/agentHref";

/**
 * Legacy `/agents/:agentId/*?…` — the agent page is now the Agent tab of its device. Old
 * bookmarks and notification links keep their query string (`?tab=`, `?at=`, `?scroll=`).
 */
export function AgentRedirect() {
  const { agentId = "" } = useParams();
  const { search } = useLocation();
  const { rows, loading } = useDeviceRows();
  if (!deviceKeyForAgent(agentId, rows)) {
    return loading ? <LoadContent label="Loading agent…" /> : <Navigate to="/" replace />;
  }
  return <Navigate to={deviceHrefForAgent(agentId, rows, { search })} replace />;
}
