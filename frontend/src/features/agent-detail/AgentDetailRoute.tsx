import { useEffect } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LoadContent } from "@/app/shell/AppShell";
import { AgentDetailPage } from "@/features/agent-detail/AgentDetailPage";
import { agentTabFromParam } from "@/features/agent-detail/lib/agentTabNav";
import { useAgents } from "@/app/providers/useAgents";
import { useNotifications } from "@/app/providers/useNotifications";
import { useSession } from "@/app/providers/useSession";
import { usePageHeader } from "@/app/shell/usePageHeader";

/** `/agents/:agentId?tab=…&at=…` — binds the URL and live fleet state to the agent page. */
export function AgentDetailRoute() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useSession();
  const { agents, agentInfo, liveStatus, initialized, setSelectedAgentId, send } = useAgents();
  const { info, warning, error } = useNotifications();
  usePageHeader({ title: "Agent Details", hideTopBar: true });

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
    setSelectedAgentId(agentId ?? null);
    return () => setSelectedAgentId(null);
  }, [agentId, setSelectedAgentId]);

  const agent = agentId ? agents[agentId] : null;
  if (!agentId) return <Navigate to="/" replace />;
  if (!agent) {
    // Once the fleet snapshot has arrived, an unknown id means the agent is gone.
    return initialized ? <Navigate to="/" replace /> : <LoadContent label="Loading agent…" />;
  }

  return (
    <AgentDetailPage
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
  );
}
