import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/utils";
import { AuditStatusBadge } from "@/components/common/AuditStatusBadge";

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
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {Object.entries(detail).map(([k, v]) => {
        let valStr = "";
        if (v === null || v === undefined) valStr = "null";
        else if (typeof v === "object") valStr = JSON.stringify(v);
        else valStr = String(v);

        return (
          <span key={k} className="whitespace-nowrap">
            <strong className="opacity-80">{k}:</strong> {valStr}
          </span>
        );
      })}
    </div>
  );
}

function matchesAuditRow(item: AuditRow, filteringText: string): boolean {
  const q = filteringText.toLowerCase();
  return (
    (item.action || "").toLowerCase().includes(q) ||
    formatAction(item.action).toLowerCase().includes(q) ||
    (item.status || "").toLowerCase().includes(q) ||
    (item.actor || "").toLowerCase().includes(q) ||
    (item.client_ip || "").toLowerCase().includes(q) ||
    JSON.stringify(item.detail || {}).toLowerCase().includes(q)
  );
}

const columnHelper = createDataTableColumns<AuditRow>();

function auditColumns(colorizeStatus: boolean) {
  return columnHelper.columns([
    columnHelper.accessor("ts", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row }) => fmtDateTime(row.original.ts),
      meta: { className: "whitespace-nowrap font-mono text-xs tabular-nums" },
    }),
    columnHelper.accessor("action", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Action" />,
      cell: ({ row }) => formatAction(row.original.action),
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("status", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => (colorizeStatus ? <AuditStatusBadge status={row.original.status} /> : row.original.status),
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("actor", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="User" />,
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor((item) => item.client_ip ?? undefined, {
      id: "client_ip",
      header: ({ column }) => <DataTableColumnHeader column={column} title="IP" />,
      cell: ({ row }) => row.original.client_ip || "—",
      meta: { className: "whitespace-nowrap font-mono text-xs" },
    }),
    columnHelper.display({
      id: "detail",
      header: "Details",
      cell: ({ row }) => formatDetail(row.original.action, row.original.detail),
      meta: { className: "max-w-96 text-[13px] text-muted-foreground" },
    }),
  ]);
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

  const columns = useMemo(() => auditColumns(colorizeStatus), [colorizeStatus]);
  const table = useDataTable({
    data: scopedRows,
    columns,
    initialSorting: [{ id: "ts", desc: true }],
    filterFn: matchesAuditRow,
  });
  const filteringText = String(table.state.globalFilter ?? "");

  return (
    <div className="flex flex-col gap-4">
      {subheader ? (
        <p className="text-sm text-muted-foreground">
          {subheader}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-xl bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
          <h2 className="font-heading text-base font-medium">
            {title}{" "}
            <span className="font-mono text-sm text-muted-foreground">({scopedRows.length})</span>
          </h2>
          <div className="flex items-center gap-2">
            <Select
              value={statusFilter.value}
              onValueChange={(next) =>
                setStatusFilter(STATUS_OPTIONS.find((o) => o.value === next) ?? STATUS_OPTIONS[0])
              }
            >
              <SelectTrigger aria-label="Filter by status" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void fetchAudit()}>
              <RefreshCw /> Refresh
            </Button>
          </div>
        </div>
        <div className="px-5 pt-3">
          <InputGroup className="h-9">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search audit log"
              placeholder="Search action, user, IP, or detail"
              value={filteringText}
              onChange={(e) => table.setGlobalFilter(e.target.value)}
            />
            {filteringText && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={() => table.setGlobalFilter("")}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        <div className="px-2 py-2">
          <DataTable
            table={table}
            loading={loading}
            loadingText="Loading audit log…"
            emptyText="No audit records yet"
            bodyClassName="[&_td]:align-top"
          />
        </div>
        <div className="border-t border-foreground/[0.06] px-5 py-1">
          <DataTablePagination table={table} />
        </div>
      </div>
    </div>
  );
}
