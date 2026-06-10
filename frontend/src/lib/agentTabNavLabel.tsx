import { SpaceBetween } from "../components/ui/console";
import { Activity, LayoutGrid, Server, Settings, Shield } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentSectionId } from "./agentTabNav";

const SECTION_META: Record<AgentSectionId, { tabLabel: string; icon: LucideIcon }> = {
  live: { tabLabel: "Live", icon: LayoutGrid },
  system: { tabLabel: "System", icon: Server },
  data: { tabLabel: "Data", icon: Activity },
  control: { tabLabel: "Control", icon: Shield },
  settings: { tabLabel: "Settings", icon: Settings },
};

export function AgentSectionTabLabel({ section }: { section: AgentSectionId }) {
  const m = SECTION_META[section];
  const Icon = m.icon;
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      <span>{m.tabLabel}</span>
    </SpaceBetween>
  );
}
