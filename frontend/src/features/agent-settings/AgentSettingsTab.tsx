import { useState } from "react";
import { usePrefetchQuery } from "@tanstack/react-query";
import { Archive, Download, ShieldCheck, SlidersHorizontal, Users, Video } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { agentQueries } from "@/api/queries/agents";
import { settingsQueries } from "@/api/queries/settings";
import type { DashboardRole } from "@/api/types";
import { AgentRecallSettings } from "@/features/recall/components/AgentRecallSettings";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { AgentGroupsCard } from "./AgentGroupsCard";
import { AgentIconCard } from "./AgentIconCard";
import { AgentModuleSettings } from "./AgentModuleSettings";
import { AgentReplacementSettings } from "./AgentReplacementSettings";
import { AgentRetentionCard } from "./AgentRetentionCard";
import { AgentAutoUpdateCard, AgentUpdateCard } from "./AgentUpdateCards";

interface Props {
  agentId: string;
  agentName: string;
  agentOnline: boolean;
  agentVersion: string | null;
  isAdmin?: boolean;
  dashboardRole?: DashboardRole | null;
  onOpenAgentGroups?: () => void;
  /** Admin only: shows the danger zone under General. */
  onDeleteAgent?: () => void;
}

/**
 * Per-computer settings (Settings tab on an agent). Each card
 * loads and saves its own setting (prefetched here); cards are keyed by agent so messages never
 * carry over to another device.
 */
export function AgentSettingsTab({
  agentId,
  agentName,
  agentOnline,
  agentVersion,
  isAdmin = false,
  dashboardRole = null,
  onOpenAgentGroups,
  onDeleteAgent,
}: Props) {
  // Backend: icon PUT = operator+; retention / auto-update /
  // update-now overrides = admin-only.
  const canOperate = dashboardRole !== "viewer";
  // Warm the cards' settings so switching sections shows them without a spinner.
  usePrefetchQuery(agentQueries.icon(agentId));
  usePrefetchQuery(settingsQueries.agentRetention(agentId));
  usePrefetchQuery(settingsQueries.agentAutoUpdate(agentId));

  const sections = [
    ...(canOperate ? [{ id: "modules", label: "Modules", Icon: ShieldCheck }] : []),
    { id: "general", label: "General", Icon: SlidersHorizontal },
    ...(isAdmin ? [{ id: "groups", label: "Groups", Icon: Users }] : []),
    { id: "retention", label: "Retention", Icon: Archive },
    { id: "recall", label: "Recall", Icon: Video },
    { id: "updates", label: "Updates", Icon: Download },
  ];
  // Wide screens get a side list (it reads as "inside Settings", apart from the tool tabs above); narrow
  // ones a grid, so no section is hidden behind a sideways scroll.
  const sideList = useMediaQuery("(min-width: 1024px)");
  // Controlled, so a role change that removes the open section (Modules for a viewer) falls back to the first one.
  const [chosen, setChosen] = useState<string | null>(null);
  const section = sections.some((candidate) => candidate.id === chosen) ? chosen : sections[0]?.id;

  return (
    <Tabs
      value={section}
      onValueChange={(next) => setChosen(String(next))}
      orientation={sideList ? "vertical" : "horizontal"}
      className={cn(sideList && "flex-row items-start gap-8")}
    >
      <TabsList
        aria-label="Agent settings sections"
        className={cn(
          sideList
            ? "w-44 shrink-0 gap-1 overflow-visible bg-transparent p-0"
            : "grid h-auto! w-full grid-cols-3 gap-1 overflow-visible md:grid-flow-col md:auto-cols-fr md:grid-cols-none",
        )}
      >
        {sections.map(({ id, label, Icon }) => (
          <TabsTrigger
            key={id}
            value={id}
            className={cn(sideList ? "h-9 flex-none justify-start px-3 data-active:bg-muted dark:data-active:bg-muted" : "h-10 flex-none px-2")}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      <div className="min-w-0 max-w-3xl flex-1">
        {canOperate && (
          <TabsContent value="modules">
            <AgentModuleSettings agentId={agentId} canOperate={canOperate} />
          </TabsContent>
        )}

        <TabsContent value="general">
          <div className="flex flex-col gap-4">
            <AgentIconCard key={`icon-${agentId}`} agentId={agentId} agentName={agentName} canOperate={canOperate} />
            {isAdmin && <AgentReplacementSettings key={agentId} agentId={agentId} agentName={agentName} />}
            {isAdmin && onDeleteAgent && (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                  <span className="min-w-0 flex-1 basis-56">Permanently removes this device and its history. You will be asked to confirm.</span>
                  <Button variant="destructive" onClick={onDeleteAgent}>
                    Delete agent
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </div>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="groups">
            <AgentGroupsCard key={agentId} agentId={agentId} onOpenAgentGroups={onOpenAgentGroups} />
          </TabsContent>
        )}

        <TabsContent value="retention">
          <AgentRetentionCard key={agentId} agentId={agentId} isAdmin={isAdmin} />
        </TabsContent>

        <TabsContent value="recall">
          <AgentRecallSettings agentId={agentId} isAdmin={isAdmin} canOperate={canOperate} />
        </TabsContent>

        <TabsContent value="updates">
          <div className="flex flex-col gap-6">
            <AgentUpdateCard key={`update-${agentId}`} agentId={agentId} agentOnline={agentOnline} agentVersion={agentVersion} isAdmin={isAdmin} />
            <AgentAutoUpdateCard key={`auto-update-${agentId}`} agentId={agentId} isAdmin={isAdmin} />
          </div>
        </TabsContent>
      </div>
    </Tabs>
  );
}
