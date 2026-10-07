import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agentQueries } from "@/api/queries/agents";
import { groupQueries } from "@/api/queries/groups";
import type { Agent, AgentGroup } from "@/api/types";
import { AlertRulesTab } from "./AlertRulesTab";
import { AppBlockingTab } from "./AppBlockingTab";
import { InternetAccessTab } from "./InternetAccessTab";
import { ScheduledScriptsTab } from "./ScheduledScriptsTab";
import { EventsGlobalTab } from "./EventsGlobalTab";

type RulesTabId = "alert-rules" | "app-blocking" | "internet-access" | "scheduled-scripts" | "events";

const RULE_TABS: { id: RulesTabId; label: string }[] = [
  { id: "alert-rules", label: "Alert Rules" },
  { id: "app-blocking", label: "App Blocking" },
  { id: "internet-access", label: "Internet Access" },
  { id: "scheduled-scripts", label: "Scheduled Scripts" },
  { id: "events", label: "Events" },
];

const NO_GROUPS: AgentGroup[] = [];
const NO_AGENTS: Agent[] = [];

const toGroups = (d: { groups: AgentGroup[] }) => d.groups ?? NO_GROUPS;
const toAgents = (d: { agents: Agent[] }) => d.agents ?? NO_AGENTS;

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

  // Scope pickers and scope labels; a failed load just leaves them empty.
  const groups = useQuery({ ...groupQueries.list(), select: toGroups }).data ?? NO_GROUPS;
  const agents = useQuery({ ...agentQueries.overview(), select: toAgents }).data ?? NO_AGENTS;

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
