import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { agentQueries } from "@/api/queries/agents";
import { groupQueries } from "@/api/queries/groups";
import type { Agent, AgentGroup } from "@/api/types";
import { AlertRulesTab } from "./AlertRulesTab";
import { AppBlockingTab } from "./AppBlockingTab";
import { InternetAccessTab } from "./InternetAccessTab";
import { ScheduledScriptsTab } from "./ScheduledScriptsTab";
import { EventsGlobalTab } from "./EventsGlobalTab";

type RulesTabId = "alert-rules" | "app-blocking" | "internet-access" | "scheduled-scripts" | "events";

// The ids are the `?tab=` values saved links use; only the labels and captions are free to change.
const RULE_TABS: { id: RulesTabId; label: string; caption: string }[] = [
  { id: "alert-rules", label: "Alerts", caption: "Get an alert when an agent visits a site, types a phrase, runs hot or goes offline." },
  { id: "app-blocking", label: "App blocking", caption: "Close chosen apps whenever they start on the agents you pick." },
  { id: "internet-access", label: "Internet", caption: "Cut internet access for agents or groups, always or on a weekly schedule." },
  { id: "scheduled-scripts", label: "Scripts", caption: "Run a script on agents every hour, day or week." },
  { id: "events", label: "Events", caption: "What the rules did: alerts, closed apps, script runs and agent connections." },
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

  // On a narrow screen the strip scrolls: keep the open section in view and hint that more lies to the right.
  const stripRef = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const update = () => setMoreRight(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4);
    strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
    update();
    strip.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      strip.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [activeTab]);

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={activeTab} onValueChange={(value) => setTab(value as RulesTabId)} className="gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-4 border-b border-foreground/[0.06]">
            <div
              ref={stripRef}
              className={`-mb-px min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${moreRight ? "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]" : ""}`}
            >
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
          <p className="text-sm text-muted-foreground">{RULE_TABS.find((t) => t.id === activeTab)?.caption}</p>
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
