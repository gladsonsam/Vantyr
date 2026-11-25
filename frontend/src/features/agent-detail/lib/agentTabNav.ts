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
  ShieldBan,
  Terminal,
  Zap,
  BarChart3,
  History,
  type LucideIcon,
} from "lucide-react";

export const TAB_KEYS = [
  "live",
  "activity",
  "recall",
  "specs",
  "software",
  "scripts",
  "logs",
  "analytics",
  "keys",
  "windows",
  "urls",
  "alerts",
  "files",
  "control",
  "terminal",
  "settings",
] as const;

export type TabKey = (typeof TAB_KEYS)[number];

export function isTabKey(value: string | null): value is TabKey {
  return (TAB_KEYS as readonly (string | null)[]).includes(value);
}

type AgentTabIcon = LucideIcon;

/**
 * Every agent tool belongs to one of five groups. The groups only organise the tool switcher and
 * the sibling row; the URL stays `?tab=<TabKey>`, so old links keep working.
 */
export type AgentSectionId = "activity" | "monitoring" | "device" | "control" | "settings";

export const AGENT_SECTION_ORDER: AgentSectionId[] = ["activity", "monitoring", "device", "control", "settings"];

/** `live` is the first Activity tool: it jumps to the desktop, with the timeline underneath. */
export const AGENT_SECTION_SUBTABS: Record<AgentSectionId, TabKey[]> = {
  activity: ["live", "activity", "recall", "analytics"],
  monitoring: ["urls", "keys", "windows", "alerts"],
  device: ["specs", "software", "files", "scripts"],
  control: ["control", "terminal", "logs"],
  settings: ["settings"],
};

export const AGENT_SECTION_META: Record<AgentSectionId, { label: string; icon: AgentTabIcon }> = {
  activity: { label: "Activity", icon: Activity },
  monitoring: { label: "Monitoring", icon: Globe },
  device: { label: "Device", icon: Cpu },
  control: { label: "Control", icon: ShieldBan },
  settings: { label: "Settings", icon: Settings },
};

export function agentSectionFromTabKey(tab: TabKey): AgentSectionId {
  for (const section of AGENT_SECTION_ORDER) {
    if (AGENT_SECTION_SUBTABS[section].includes(tab)) return section;
  }
  return "activity";
}

/** Agent page tab from the `?tab=` query value; the legacy "screen" maps to "live". */
export function agentTabFromParam(tab: string | null): TabKey {
  if (tab === "screen") return "live";
  return isTabKey(tab) ? tab : "activity";
}

interface AgentTabDefinition {
  /** Short and concrete: what the person will see, not how the system is organised. */
  label: string;
  /** One line shown only inside the tool switcher. */
  hint: string;
  /** Extra words the switcher search matches (old names, synonyms). */
  keywords: string[];
  icon: AgentTabIcon;
}

export const AGENT_TAB_META: Record<TabKey, AgentTabDefinition> = {
  live: { label: "Live desktop", hint: "Watch and control the screen", keywords: ["screen", "remote", "view", "control", "desktop"], icon: Monitor },
  activity: { label: "Timeline", hint: "What happened, hour by hour", keywords: ["history", "sessions", "events", "feed"], icon: Activity },
  recall: { label: "Recall", hint: "Replay what was on screen", keywords: ["screenshots", "recordings", "frames", "playback", "history"], icon: History },
  analytics: { label: "Analytics", hint: "Browsing time and top sites", keywords: ["usage", "charts", "categories", "stats", "reports"], icon: BarChart3 },
  urls: { label: "Websites", hint: "Pages visited, with categories", keywords: ["urls", "browsing", "history", "links", "sites", "chrome"], icon: Globe },
  keys: { label: "Keystrokes", hint: "What was typed, by app", keywords: ["keys", "typing", "keyboard", "keylogger", "text"], icon: Keyboard },
  windows: { label: "App windows", hint: "Which apps and windows were in use", keywords: ["apps", "programs", "focus", "titles"], icon: LayoutGrid },
  alerts: { label: "Rule events", hint: "Alerts raised by rules", keywords: ["alerts", "events", "triggers", "notifications"], icon: Zap },
  specs: { label: "Specs", hint: "Hardware, drives and network", keywords: ["hardware", "cpu", "memory", "ram", "disk", "drives", "network", "os", "system"], icon: Cpu },
  software: { label: "Software", hint: "Installed apps", keywords: ["programs", "installed", "uninstall", "updates", "apps"], icon: Package },
  files: { label: "Files", hint: "Browse and transfer files", keywords: ["folders", "download", "upload", "explorer", "browse"], icon: FolderOpen },
  scripts: { label: "Run scripts", hint: "Run commands on the device", keywords: ["scripts", "powershell", "bash", "command", "automation", "run"], icon: Terminal },
  control: { label: "Blocking", hint: "Block apps and network access", keywords: ["control", "block", "firewall", "internet", "overview", "restrict"], icon: ShieldBan },
  terminal: { label: "Terminal", hint: "Open a shell on the device", keywords: ["shell", "console", "cmd", "powershell", "ssh"], icon: Terminal },
  logs: { label: "Device logs", hint: "Log output from the agent", keywords: ["logs", "debug", "diagnostics", "troubleshoot", "errors"], icon: FileText },
  settings: { label: "Settings", hint: "Modules, groups, updates and removal", keywords: ["modules", "permissions", "groups", "retention", "delete", "remove", "update", "icon"], icon: Settings },
};

function wordStarts(text: string, token: string): boolean {
  return text.split(/[^a-z0-9]+/).some((word) => word.startsWith(token));
}

/** How well one search word fits a tool: lower is better, null is no match. Whole words only; no fuzzy matching. */
function tokenScore(tab: TabKey, token: string): number | null {
  const meta = AGENT_TAB_META[tab];
  const label = meta.label.toLowerCase();
  if (label.startsWith(token)) return 0;
  if (wordStarts(label, token)) return 1;
  if (label.includes(token)) return 2;
  const group = AGENT_SECTION_META[agentSectionFromTabKey(tab)].label.toLowerCase();
  const loose = `${meta.keywords.join(" ")} ${meta.hint}`.toLowerCase();
  if (wordStarts(loose, token)) return 3;
  if (wordStarts(group, token)) return 4;
  if (loose.includes(token)) return 5;
  return null;
}

/** Tools matching every word of `query`, best match first (catalog order breaks ties). Empty query → no filtering. */
export function searchAgentTabs(query: string): TabKey[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return AGENT_SECTION_ORDER.flatMap((section) => AGENT_SECTION_SUBTABS[section]);
  const ranked: { tab: TabKey; score: number; order: number }[] = [];
  AGENT_SECTION_ORDER.flatMap((section) => AGENT_SECTION_SUBTABS[section]).forEach((tab, order) => {
    let score = 0;
    for (const token of tokens) {
      const s = tokenScore(tab, token);
      if (s === null) return;
      score += s;
    }
    ranked.push({ tab, score, order });
  });
  return ranked.sort((a, b) => a.score - b.score || a.order - b.order).map((r) => r.tab);
}
