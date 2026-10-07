import type { DashboardRole } from "@/api/types";

export const ROLE_OPTIONS: { label: string; value: DashboardRole; description: string }[] = [
  {
    label: "Viewer",
    value: "viewer",
    description: "Read agents, telemetry, activity, and audit log. Cannot use live screen, remote actions, or scripts.",
  },
  {
    label: "Operator",
    value: "operator",
    description:
      "Everything viewers can do, plus live screen, wake/clear history, software inventory refresh, agent icon, and remote scripts (when enabled on the server).",
  },
  {
    label: "Admin",
    value: "admin",
    description:
      "Full control: retention, auto-update policy, local UI passwords, users, agent groups, and alert rules.",
  },
];

/** Role is carried by text hue, never a chip. */
export const ROLE_TEXT: Record<DashboardRole, string> = {
  admin: "text-warning",
  operator: "text-info",
  viewer: "text-muted-foreground",
};
