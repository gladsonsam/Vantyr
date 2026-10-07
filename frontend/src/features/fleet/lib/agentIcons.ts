import type { ComponentType } from "react";
import {
  Monitor,
  Laptop,
  Server,
  Building2,
  Home,
  Shield,
  Database,
  Router,
  Wifi,
  Terminal,
  Globe,
  Camera,
  HardDrive,
  Cpu,
  Network,
  BriefcaseBusiness,
  GraduationCap,
  Factory,
  Store,
} from "lucide-react";

export type AgentIconKey =
  | "monitor"
  | "laptop"
  | "server"
  | "building"
  | "home"
  | "shield"
  | "database"
  | "router"
  | "wifi"
  | "terminal"
  | "globe"
  | "camera"
  | "drive"
  | "cpu"
  | "network"
  | "business"
  | "school"
  | "factory"
  | "store";

type IconDef = {
  key: AgentIconKey;
  label: string;
  Icon: ComponentType<{ size?: number; color?: string; className?: string }>;
};

export const AGENT_ICON_DEFS: readonly IconDef[] = [
  { key: "monitor", label: "Desktop", Icon: Monitor },
  { key: "laptop", label: "Laptop", Icon: Laptop },
  { key: "server", label: "Server", Icon: Server },
  { key: "building", label: "Office", Icon: Building2 },
  { key: "home", label: "Home", Icon: Home },
  { key: "shield", label: "Secure", Icon: Shield },
  { key: "database", label: "Database", Icon: Database },
  { key: "router", label: "Router", Icon: Router },
  { key: "wifi", label: "Wi‑Fi", Icon: Wifi },
  { key: "terminal", label: "Terminal", Icon: Terminal },
  { key: "globe", label: "Internet", Icon: Globe },
  { key: "camera", label: "Camera", Icon: Camera },
  { key: "drive", label: "Storage", Icon: HardDrive },
  { key: "cpu", label: "CPU", Icon: Cpu },
  { key: "network", label: "Network", Icon: Network },
  { key: "business", label: "Business", Icon: BriefcaseBusiness },
  { key: "school", label: "School", Icon: GraduationCap },
  { key: "factory", label: "Factory", Icon: Factory },
  { key: "store", label: "Store", Icon: Store },
] as const;

export const AGENT_ICON_MAP: Readonly<Record<AgentIconKey, IconDef>> = AGENT_ICON_DEFS.reduce(
  (acc, d) => {
    acc[d.key] = d;
    return acc;
  },
  {} as Record<AgentIconKey, IconDef>,
);

export function isAgentIconKey(v: unknown): v is AgentIconKey {
  return typeof v === "string" && (v as string) in AGENT_ICON_MAP;
}

