import { useEffect } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { LoadContent } from "@/app/shell/AppShell";
import { AgentDetailPage } from "./AgentDetailPage";
import { AgentToolsPathContext } from "./agentToolsPath";
import { agentTabFromParam } from "@/features/agent-detail/lib/agentTabNav";
import { useAgents } from "@/app/providers/useAgents";
import { useNotifications } from "@/app/providers/useNotifications";
import { useSession } from "@/app/providers/useSession";
import { useDevice } from "@/features/devices/deviceContext";

/**
 * `/devices/:deviceKey/agent?tab=…&at=…` — the agent tools inside the device page. The device
 * header stands in for the old agent header; the tool is still picked with `?tab=`.
 */
export function AgentToolsRoute() {
  const device = useDevice();
  const agentId = device.agentId;
  const base = `/devices/${device.key}`;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useSession();
  const { agents, agentInfo, liveStatus, initialized, setSelectedAgentId, send } = useAgents();
  const { info, warning, error } = useNotifications();

  const activeTab = agentTabFromParam(searchParams.get("tab"));
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (searchParams.get("tab") !== "screen") return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", "live");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    setSelectedAgentId(agentId);
    return () => setSelectedAgentId(null);
  }, [agentId, setSelectedAgentId]);

  const agent = agentId ? agents[agentId] : null;
  if (!agentId) return <Navigate to={base} replace />;
  if (!agent) {
    // Once the fleet snapshot has arrived, an unknown id means the agent is gone.
    return initialized ? <Navigate to={base} replace /> : <LoadContent label="Loading agent…" />;
  }

  return (
    <AgentToolsPathContext.Provider value={`${base}/agent`}>
      <AgentDetailPage
        embedded
        agent={agent}
        agents={agents}
        agentInfo={agentInfo[agent.id] || null}
        agentInfoById={agentInfo}
        liveStatus={liveStatus[agent.id]}
        liveStatusById={liveStatus}
        sendWsMessage={send}
        onNotifyInfo={info}
        onNotifyWarning={warning}
        onNotifyError={error}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("tab", tab);
            return next;
          });
        }}
        onBackToOverview={() => navigate("/")}
        onSelectAgent={(nextAgentId) => navigate(`/agents/${nextAgentId}?tab=${activeTab}`)}
        // ISO timestamp for timeline highlight (from ?at=)
        highlightTimestamp={searchParams.get("at") ?? null}
        isAdmin={isAdmin}
        onOpenAgentGroups={isAdmin ? () => navigate("/groups") : undefined}
        dashboardRole={user?.role ?? null}
        dashboardAccountId={user?.id ?? null}
      />
    </AgentToolsPathContext.Provider>
  );
}
