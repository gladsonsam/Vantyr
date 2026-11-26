import type { ApiClient } from "@/api";
import { demoAgents, isoHoursAgo, isoMinutesAgo } from "@/demo/data";

type DemoAuditRow = {
  id: number;
  ts: string;
  actor: string;
  client_ip: string | null;
  agent_id: string | null;
  action: string;
  status: string;
  detail: Record<string, unknown>;
};

/** Synthetic records, newest first, over several days: sign-ins, operator actions, failures and page views. */
function demoAuditRows(): DemoAuditRow[] {
  const devices = ["desktop", "laptop"];
  const templates: Omit<DemoAuditRow, "id" | "ts" | "agent_id">[] = [
    { actor: "auth", client_ip: "203.0.113.24", action: "login", status: "ok", detail: {} },
    {
      actor: "admin",
      client_ip: "10.0.3.5",
      action: "view_windows",
      status: "ok",
      detail: { limit: 50, offset: 0 },
    },
    {
      actor: "admin",
      client_ip: "10.0.3.5",
      action: "run_script",
      status: "ok",
      detail: {
        shell: "powershell",
        timeout_secs: 60,
        script: "Get-Service | Where-Object Status -eq Running",
      },
    },
    {
      actor: "admin",
      client_ip: "10.0.3.5",
      action: "view_agent_logs",
      status: "ok",
      detail: { kind: "agent", max_kb: 64 },
    },
    {
      actor: "operator",
      client_ip: "10.0.3.9",
      action: "update_internet_policy",
      status: "ok",
      detail: { blocked: true, reason: "Exam in progress" },
    },
    {
      actor: "auth",
      client_ip: "198.51.100.77",
      action: "login",
      status: "rejected",
      detail: { reason: "too many attempts", retry_after_secs: 300 },
    },
    {
      actor: "admin",
      client_ip: "10.0.3.5",
      action: "run_command",
      status: "error",
      detail: {
        cmd_type: "ListDir",
        path: "C:\\Users\\Public\\Documents\\Quarterly reports\\2026\\Q3\\drafts",
        error: '{"code":"module_not_authorized","message":"module not authorized"}',
      },
    },
    {
      actor: "operator",
      client_ip: null,
      action: "toggle_app_block_rule",
      status: "ok",
      detail: { rule_id: 4, enabled: false },
    },
    { actor: "admin", client_ip: "10.0.3.5", action: "view_urls", status: "ok", detail: {} },
    {
      actor: "admin",
      client_ip: "10.0.3.5",
      action: "power_action",
      status: "error",
      detail: { action: "restart", error: "device offline" },
    },
  ];
  return Array.from({ length: 140 }, (_, i) => {
    const template = templates[(i * 7 + (i % 3)) % templates.length];
    const device = template.action === "login" ? null : devices[i % devices.length];
    return { ...template, id: 140 - i, ts: isoMinutesAgo(4 + i * 47), agent_id: device };
  });
}

/** Fake audit trail and sessions endpoints. */
export function demoAuditApi(): Partial<ApiClient> {
  return {
    audit: async (params) => {
      const rows = demoAuditRows().filter(
        (row) =>
          (!params?.agent_id || row.agent_id === params.agent_id) &&
          (!params?.status || row.status === params.status),
      );
      return { rows: rows.slice(0, params?.limit ?? 500) };
    },
    agentSessionsAll: async () => ({
      rows: demoAgents.map((a, i) => ({
        id: i + 1,
        agent_id: a.id,
        agent_name: a.name,
        connected_at: a.last_connected_at ?? isoHoursAgo(i + 1),
        disconnected_at: a.online ? null : a.last_disconnected_at,
      })),
    }),
  };
}
