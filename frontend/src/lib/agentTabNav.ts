import {
  Activity,
  Monitor,
  Cpu,
  FolderOpen,
  Keyboard,
  LayoutGrid,
  Globe,
  Package,
  FileText,
  Settings,
  Shield,
  Terminal,
  Zap,
  BarChart3,
  History,
  type LucideIcon,
} from "lucide-react";
import type { TabKey } from "./types";

type AgentTabIcon = LucideIcon;

/** Two-level tab nav: 5 primary sections, each with its own sub-tabs. */
type AgentSectionId = "activity" | "telemetry" | "system" | "control" | "settings";

export const AGENT_SECTION_ORDER: AgentSectionId[] = ["activity", "telemetry", "system", "control", "settings"];

export const AGENT_SECTION_SUBTABS: Record<AgentSectionId, TabKey[]> = {
  activity: ["activity", "recall", "analytics"],
  telemetry: ["urls", "keys", "windows", "alerts"],
  system: ["specs", "software", "scripts", "files"],
  control: ["control", "terminal", "logs"],
  settings: ["settings"],
};

export const AGENT_SECTION_META: Record<AgentSectionId, { label: string; icon: AgentTabIcon }> = {
  activity: { label: "Activity", icon: Activity },
  telemetry: { label: "Telemetry", icon: Globe },
  system: { label: "System", icon: Cpu },
  control: { label: "Control", icon: Shield },
  settings: { label: "Settings", icon: Settings },
};

export function agentSectionFromTabKey(tab: TabKey): AgentSectionId {
  for (const section of AGENT_SECTION_ORDER) {
    if (AGENT_SECTION_SUBTABS[section].includes(tab)) return section;
  }
  return "activity";
}

export function defaultTabForAgentSection(section: AgentSectionId): TabKey {
  return AGENT_SECTION_SUBTABS[section][0];
}

interface AgentTabDefinition {
  tabLabel: string;
  sideNavLabel: string;
  breadcrumbLabel: string;
  icon: AgentTabIcon;
}

export const AGENT_TAB_META: Record<TabKey, AgentTabDefinition> = {
  live: { tabLabel: "Screen + activity", sideNavLabel: "Live desk", breadcrumbLabel: "Live desk", icon: Monitor },
  activity: { tabLabel: "Timeline only", sideNavLabel: "Timeline", breadcrumbLabel: "Activity timeline", icon: Activity },
  recall: { tabLabel: "Recall", sideNavLabel: "Recall", breadcrumbLabel: "Recall", icon: History },
  specs: { tabLabel: "Specs", sideNavLabel: "Specs", breadcrumbLabel: "Specs", icon: Cpu },
  software: { tabLabel: "Software", sideNavLabel: "Software", breadcrumbLabel: "Software", icon: Package },
  scripts: { tabLabel: "Scripts", sideNavLabel: "Scripts", breadcrumbLabel: "Scripts", icon: Terminal },
  analytics: { tabLabel: "Analytics", sideNavLabel: "Analytics", breadcrumbLabel: "Analytics", icon: BarChart3 },
  logs: { tabLabel: "Logs", sideNavLabel: "Logs", breadcrumbLabel: "Logs", icon: FileText },
  keys: { tabLabel: "Keys", sideNavLabel: "Keystrokes", breadcrumbLabel: "Keystrokes", icon: Keyboard },
  windows: { tabLabel: "Windows", sideNavLabel: "Windows", breadcrumbLabel: "Windows", icon: LayoutGrid },
  urls: { tabLabel: "URLs", sideNavLabel: "URLs", breadcrumbLabel: "URLs", icon: Globe },
  alerts: { tabLabel: "Events", sideNavLabel: "Events", breadcrumbLabel: "Rule events", icon: Zap },
  files: { tabLabel: "Files", sideNavLabel: "Files", breadcrumbLabel: "Files", icon: FolderOpen },
  control: { tabLabel: "Control", sideNavLabel: "Control", breadcrumbLabel: "Control", icon: Shield },
  terminal: { tabLabel: "Terminal", sideNavLabel: "Terminal", breadcrumbLabel: "Terminal", icon: Terminal },
  settings: { tabLabel: "Settings", sideNavLabel: "Settings", breadcrumbLabel: "Settings", icon: Settings },
};
