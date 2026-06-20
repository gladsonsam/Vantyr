import { Box, Button, Header, Pagination, Select, SpaceBetween, Table, TextFilter } from "../ui/console";
import { useCollection } from "../../hooks/useCollection";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { AuditStatusBadge } from "../common/AuditStatusBadge";

interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  client_ip?: string | null;
  agent_id: string | null;
  action: string;
  status: "ok" | "error" | "rejected" | string;
  detail: Record<string, unknown>;
}

interface AuditTabProps {
  /** When set, only rows for this agent (same API as global log). */
  agentId?: string;
  /** Narrow global log: authentication-only vs operator/API (ignored when `agentId` is set). */
  scope?: "all" | "auth" | "operator";
  /** Colour-code status column (green / yellow / red tiers). Default true. */
  colorizeStatus?: boolean;
  /** Table header title (default: Audit log). */
  title?: string;
  /** Shown above the table. */
  subheader?: string;
}

const STATUS_OPTIONS = [
  { label: "All statuses", value: "all" },
  { label: "OK", value: "ok" },
  { label: "Error", value: "error" },
  { label: "Rejected", value: "rejected" },
];

function formatAction(action: string): string {
  const mapping: Record<string, string> = {
    view_agent_logs: "View Agent Logs",
    view_windows: "View Windows",
    view_urls: "View URLs",
    view_activity: "View Activity",
    view_keys: "View Keystrokes",
    view_alert_rule_events: "View Alerts",
    view_files: "View Files",
    view_screen: "View Screen",
    view_scripts: "View Scripts",
    update_network_policy: "Update Internet Block",
    update_internet_policy: "Update Internet Block",
    delete_app_block_rule: "Delete App Block Rule",
    create_app_block_rule: "Create App Block Rule",
    toggle_app_block_rule: "Toggle App Block Rule",
    run_script: "Run Script",
    power_action: "Trigger Power Action",
  };

  if (mapping[action]) return mapping[action];

  return action
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDetail(action: string, detail: Record<string, unknown>): React.ReactNode {
  if (!detail || Object.keys(detail).length === 0) return "—";

  if (action === "view_agent_logs" && typeof detail.kind === "string") {
    const maxKb = detail.max_kb ? ` (max ${detail.max_kb} KB)` : "";
    return `Source: ${detail.kind}${maxKb}`;
  }

  const keys = Object.keys(detail);
  if (keys.length === 2 && keys.includes("limit") && keys.includes("offset")) {
    return "—";
  }
  if (keys.length === 1 && (keys.includes("limit") || keys.includes("offset"))) {
    return "—";
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
      {Object.entries(detail).map(([k, v]) => {
        let valStr = "";
        if (v === null || v === undefined) valStr = "null";
        else if (typeof v === "object") valStr = JSON.stringify(v);
        else valStr = String(v);

        return (
          <span key={k} style={{ whiteSpace: "nowrap" }}>
            <strong style={{ opacity: 0.8 }}>{k}:</strong> {valStr}
          </span>
        );
      })}
    </div>
  );
}

export function AuditTab({
  agentId,
  scope = "all",
  colorizeStatus = true,
  title = "Audit log",
  subheader,
}: AuditTabProps) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState(STATUS_OPTIONS[0]);

  const fetchAudit = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.audit({
        limit: 500,
        agent_id: agentId,
        status: statusFilter.value !== "all" ? statusFilter.value : undefined,
      });
      const list = Array.isArray(data?.rows) ? data.rows : [];
      setRows(
        list.map((r: Record<string, unknown>) => ({
          id: Number(r.id ?? 0),
          ts: String(r.ts ?? r.timestamp ?? ""),
          actor: String(r.actor ?? "operator"),
          client_ip: (r.client_ip as string | null | undefined) ?? null,
          agent_id: (r.agent_id as string | null | undefined) ?? null,
          action: String(r.action ?? "unknown"),
          status: String(r.status ?? "ok"),
          detail: (r.detail as Record<string, unknown> | undefined) ?? {},
        }))
      );
    } catch (err) {
      console.error("Failed to fetch audit logs:", err);
    } finally {
      setLoading(false);
    }
  }, [agentId, statusFilter.value]);

  useEffect(() => {
    void fetchAudit();
  }, [fetchAudit]);

  const scopedRows = useMemo(() => {
    if (agentId) return rows;
    if (scope === "auth") return rows.filter((r) => r.actor === "auth");
    if (scope === "operator") return rows.filter((r) => r.actor !== "auth");
    return rows;
  }, [rows, scope, agentId]);

  const { items, collectionProps, filterProps, paginationProps } = useCollection(scopedRows, {
    filtering: {
      filteringFunction: (item, filteringText) => {
        const q = filteringText.toLowerCase();
        return (
          (item.action || "").toLowerCase().includes(q) ||
          formatAction(item.action).toLowerCase().includes(q) ||
          (item.status || "").toLowerCase().includes(q) ||
          (item.actor || "").toLowerCase().includes(q) ||
          (item.client_ip || "").toLowerCase().includes(q) ||
          JSON.stringify(item.detail || {}).toLowerCase().includes(q)
        );
      },
      empty: "No audit records",
      noMatch: "No audit records match the current filters",
    },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: "ts" },
        isDescending: true,
      },
    },
    pagination: { pageSize: 50 },
  });

  return (
    <SpaceBetween size="m">
      {subheader ? (
        <Box fontSize="body-s" color="text-body-secondary">
          {subheader}
        </Box>
      ) : null}
      <Table
      {...collectionProps}
      loading={loading}
      loadingText="Loading audit log..."
      items={items}
      variant="container"
      stickyHeader
      columnDefinitions={[
        {
          id: "ts",
          header: "Time",
          cell: (item) => fmtDateTime(item.ts),
          sortingField: "ts",
          width: 190,
        },
        {
          id: "action",
          header: "Action",
          cell: (item) => formatAction(item.action),
          sortingField: "action",
          width: 180,
        },
        {
          id: "status",
          header: "Status",
          cell: (item) =>
            colorizeStatus ? (
              <AuditStatusBadge status={item.status} />
            ) : (
              item.status
            ),
          sortingField: "status",
          width: 120,
        },
        {
          id: "user",
          header: "User",
          cell: (item) => item.actor,
          sortingField: "actor",
          width: 120,
        },
        {
          id: "client_ip",
          header: "IP",
          cell: (item) => item.client_ip || "—",
          sortingField: "client_ip",
          width: 140,
        },
        {
          id: "detail",
          header: "Details",
          cell: (item) => (
            <Box fontSize="body-s" color="text-body-secondary">
              {formatDetail(item.action, item.detail)}
            </Box>
          ),
        },
      ]}
      header={
        <Header
          counter={`(${scopedRows.length})`}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={statusFilter}
                onChange={({ detail }) =>
                  setStatusFilter(
                    (detail.selectedOption as typeof STATUS_OPTIONS[number]) || STATUS_OPTIONS[0]
                  )
                }
                options={STATUS_OPTIONS}
              />
              <Button iconName="refresh" onClick={fetchAudit}>
                Refresh
              </Button>
            </SpaceBetween>
          }
        >
          {title}
        </Header>
      }
      filter={
        <TextFilter
          {...filterProps}
          filteringPlaceholder="Search action, status, user, IP, or detail JSON"
        />
      }
      pagination={<Pagination {...paginationProps} />}
      empty={
        <Box textAlign="center">
          <Box variant="p" color="text-body-secondary">
            No audit records yet
          </Box>
        </Box>
      }
    />
    </SpaceBetween>
  );
}
