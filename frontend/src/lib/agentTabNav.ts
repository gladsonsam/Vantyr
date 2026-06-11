import type { ComponentType } from "react";
import {
  Activity,
  Monitor,
  Cpu,
  FolderOpen,
  Keyboard,
  SquaresFour,
  Globe,
  Package,
  FileText,
  Gear,
  Shield,
  Terminal,
  Lightning,
  ChartBar,
} from "phosphor-react";
import type { TabKey } from "./types";

/** Two-level tab nav: 5 primary sections, each with its own sub-tabs. */
export type AgentSectionId = "activity" | "telemetry" | "system" | "control" | "settings";

export const AGENT_SECTION_ORDER: AgentSectionId[] = ["activity", "telemetry", "system", "control", "settings"];

export const AGENT_SECTION_SUBTABS: Record<AgentSectionId, TabKey[]> = {
  activity: ["activity", "analytics"],
  telemetry: ["urls", "keys", "windows", "alerts"],
  system: ["specs", "software", "scripts", "files"],
  control: ["control", "logs"],
  settings: ["settings"],
};

export const AGENT_SECTION_META: Record<AgentSectionId, { label: string; icon: ComponentType<any> }> = {
  activity: { label: "Activity", icon: Activity },
  telemetry: { label: "Telemetry", icon: Globe },
  system: { label: "System", icon: Cpu },
  control: { label: "Control", icon: Shield },
  settings: { label: "Settings", icon: Gear },
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

export const AGENT_TAB_ORDER: TabKey[] = [
  "activity",
  "live",
  "control",
  "specs",
  "software",
  "scripts",
  "files",
  "analytics",
  "keys",
  "windows",
  "urls",
  "alerts",
  "logs",
  "settings",
];

export interface AgentTabDefinition {
  tabLabel: string;
  sideNavLabel: string;
  breadcrumbLabel: string;
  icon: ComponentType<any>;
}

export const AGENT_TAB_META: Record<TabKey, AgentTabDefinition> = {
  live: { tabLabel: "Screen + activity", sideNavLabel: "Live desk", breadcrumbLabel: "Live desk", icon: Monitor },
  activity: { tabLabel: "Timeline only", sideNavLabel: "Timeline", breadcrumbLabel: "Activity timeline", icon: Activity },
  specs: { tabLabel: "Specs", sideNavLabel: "Specs", breadcrumbLabel: "Specs", icon: Cpu },
  software: { tabLabel: "Software", sideNavLabel: "Software", breadcrumbLabel: "Software", icon: Package },
  scripts: { tabLabel: "Scripts", sideNavLabel: "Scripts", breadcrumbLabel: "Scripts", icon: Terminal },
  analytics: { tabLabel: "Analytics", sideNavLabel: "Analytics", breadcrumbLabel: "Analytics", icon: ChartBar },
  logs: { tabLabel: "Logs", sideNavLabel: "Logs", breadcrumbLabel: "Logs", icon: FileText },
  keys: { tabLabel: "Keys", sideNavLabel: "Keystrokes", breadcrumbLabel: "Keystrokes", icon: Keyboard },
  windows: { tabLabel: "Windows", sideNavLabel: "Windows", breadcrumbLabel: "Windows", icon: SquaresFour },
  urls: { tabLabel: "URLs", sideNavLabel: "URLs", breadcrumbLabel: "URLs", icon: Globe },
  alerts: { tabLabel: "Events", sideNavLabel: "Events", breadcrumbLabel: "Rule events", icon: Lightning },
  files: { tabLabel: "Files", sideNavLabel: "Files", breadcrumbLabel: "Files", icon: FolderOpen },
  control: { tabLabel: "Control", sideNavLabel: "Control", breadcrumbLabel: "Control", icon: Shield },
  settings: { tabLabel: "Settings", sideNavLabel: "Settings", breadcrumbLabel: "Settings", icon: Gear },
};

export function agentTabBreadcrumbLabel(tab: TabKey): string {
  return AGENT_TAB_META[tab].breadcrumbLabel;
}
