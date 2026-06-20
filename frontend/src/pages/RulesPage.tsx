import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ContentLayout, Header, Tabs } from "../components/ui/console";
import { api } from "../lib/api";
import type { Agent, AgentGroup } from "../lib/types";
import { AlertRulesTab } from "../components/rules/AlertRulesTab";
import { AppBlockingTab } from "../components/rules/AppBlockingTab";
import { InternetAccessTab } from "../components/rules/InternetAccessTab";
import { ScheduledScriptsTab } from "../components/rules/ScheduledScriptsTab";
import { EventsGlobalTab } from "../components/rules/EventsGlobalTab";

type RulesTabId = "alert-rules" | "app-blocking" | "internet-access" | "scheduled-scripts" | "events";

export function RulesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as RulesTabId) ?? "alert-rules";

  const setTab = (id: RulesTabId) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set("tab", id); return n; }, { replace: true });
  };

  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    void api.agentGroupsList().then((d) => setGroups(d.groups ?? [])).catch(() => { });
    void api.agentsOverview().then((d) => setAgents(d.agents ?? [])).catch(() => { });
  }, []);

  return (
    <ContentLayout header={<Header variant="h1" description="Manage alert rules, app blocking, and view all rule events across devices.">Rules</Header>}>
      <div className="vantyr-admin-page vantyr-rules-page sx-console">
      <Tabs
        activeTabId={activeTab}
        onChange={({ detail }) => setTab(detail.activeTabId as RulesTabId)}
        tabs={[
          { id: "alert-rules", label: "Alert Rules", content: <AlertRulesTab groups={groups} agents={agents} /> },
          { id: "app-blocking", label: "App Blocking", content: <AppBlockingTab groups={groups} agents={agents} /> },
          { id: "internet-access", label: "Internet Access", content: <InternetAccessTab groups={groups} agents={agents} /> },
          { id: "scheduled-scripts", label: "Scheduled Scripts", content: <ScheduledScriptsTab groups={groups} agents={agents} /> },
          { id: "events", label: "Events", content: <EventsGlobalTab /> },
        ]}
      />
      </div>
    </ContentLayout>
  );
}
