import { usePrefetchQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agentQueries } from "@/api/queries/agents";
import { settingsQueries } from "@/api/queries/settings";
import type { DashboardRole } from "@/api/types";
import { SecuritySettings } from "@/features/settings/SecuritySettings";
import { AgentRecallSettings } from "@/features/recall/components/AgentRecallSettings";
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
}

/**
 * Per-computer settings and on-device security guidance (Settings tab on an agent). Each card
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
}: Props) {
  // Backend: icon PUT = operator+; retention / auto-update /
  // update-now overrides = admin-only.
  const canOperate = dashboardRole !== "viewer";
  // Warm the cards' settings so switching sections shows them without a spinner.
  usePrefetchQuery(agentQueries.icon(agentId));
  usePrefetchQuery(settingsQueries.agentRetention(agentId));
  usePrefetchQuery(settingsQueries.agentAutoUpdate(agentId));

  const tabs = [
    ...(canOperate ? [{ id: "modules", label: "Modules" }] : []),
    { id: "general", label: "General" },
    ...(isAdmin ? [{ id: "groups", label: "Groups" }] : []),
    { id: "retention", label: "Retention" },
    { id: "recall", label: "Recall" },
    { id: "security", label: "Security" },
    { id: "updates", label: "Updates" },
  ];

  return (
    <Tabs defaultValue={tabs[0]?.id}>
      <TabsList aria-label="Agent settings sections">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {canOperate && (
        <TabsContent value="modules">
          <AgentModuleSettings agentId={agentId} canOperate={canOperate} />
        </TabsContent>
      )}

      <TabsContent value="general">
        <div className="flex flex-col gap-6">
          {isAdmin && <AgentReplacementSettings key={agentId} agentId={agentId} agentName={agentName} />}
          <AgentIconCard key={`icon-${agentId}`} agentId={agentId} canOperate={canOperate} />
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
        <AgentRecallSettings agentId={agentId} isAdmin={isAdmin} />
      </TabsContent>

      <TabsContent value="security">
        <SecuritySettings />
      </TabsContent>

      <TabsContent value="updates">
        <div className="flex flex-col gap-6">
          <AgentUpdateCard key={`update-${agentId}`} agentId={agentId} agentOnline={agentOnline} agentVersion={agentVersion} isAdmin={isAdmin} />
          <AgentAutoUpdateCard key={`auto-update-${agentId}`} agentId={agentId} isAdmin={isAdmin} />
        </div>
      </TabsContent>
    </Tabs>
  );
}
