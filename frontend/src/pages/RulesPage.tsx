import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { Agent, AgentGroup } from "@/lib/types";
import { AlertRulesTab } from "@/components/rules/AlertRulesTab";
import { AppBlockingTab } from "@/components/rules/AppBlockingTab";
import { InternetAccessTab } from "@/components/rules/InternetAccessTab";
import { ScheduledScriptsTab } from "@/components/rules/ScheduledScriptsTab";
import { EventsGlobalTab } from "@/components/rules/EventsGlobalTab";

type RulesTabId = "alert-rules" | "app-blocking" | "internet-access" | "scheduled-scripts" | "events";

const RULE_TABS: { id: RulesTabId; label: string }[] = [
  { id: "alert-rules", label: "Alert Rules" },
  { id: "app-blocking", label: "App Blocking" },
  { id: "internet-access", label: "Internet Access" },
  { id: "scheduled-scripts", label: "Scheduled Scripts" },
  { id: "events", label: "Events" },
];

function parseRulesTab(v: string | null): RulesTabId {
  return RULE_TABS.some((t) => t.id === v) ? (v as RulesTabId) : "alert-rules";
}

export function RulesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseRulesTab(searchParams.get("tab"));

  const setTab = (id: RulesTabId) => {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set("tab", id);
        return n;
      },
      { replace: true },
    );
  };

  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    void api.agentGroupsList().then((d) => setGroups(d.groups ?? [])).catch(() => {});
    void api.agentsOverview().then((d) => setAgents(d.agents ?? [])).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={activeTab} onValueChange={(value) => setTab(value as RulesTabId)} className="gap-6">
        <div className="flex items-end gap-4 border-b border-foreground/[0.06]">
          <div className="-mb-px min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList variant="line" aria-label="Rules sections" className="h-11! gap-2 p-0">
              {RULE_TABS.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="h-full! flex-none gap-2 px-2.5 after:bottom-0!"
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>
        <TabsContent value="alert-rules">
          <AlertRulesTab groups={groups} agents={agents} />
        </TabsContent>
        <TabsContent value="app-blocking">
          <AppBlockingTab groups={groups} agents={agents} />
        </TabsContent>
        <TabsContent value="internet-access">
          <InternetAccessTab groups={groups} agents={agents} />
        </TabsContent>
        <TabsContent value="scheduled-scripts">
          <ScheduledScriptsTab groups={groups} agents={agents} />
        </TabsContent>
        <TabsContent value="events">
          <EventsGlobalTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
