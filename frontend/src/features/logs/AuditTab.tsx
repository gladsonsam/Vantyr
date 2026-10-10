import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditQueries, type AuditLogParams } from "@/api/queries/audit";
import type { AuditRecord } from "@/api/types";
import { fmtDateTime } from "@/lib/utils";
import { AuditStatusBadge } from "./AuditStatusBadge";
import { formatAuditDetail } from "./auditDetail";

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

function AuditDetail({ action, detail }: { action: string; detail: Record<string, unknown> }) {
  const { pairs, full } = formatAuditDetail(action, detail);
  if (pairs.length === 0) return <span className="text-muted-foreground/70">No details</span>;
  return (
    <p className="line-clamp-2 break-words" title={full ?? undefined}>
      {pairs.map((p, i) => (
        <span key={p.label}>
          {i > 0 && <span className="px-1.5 text-muted-foreground/50">·</span>}
          <span className="text-muted-foreground/70">{p.label}</span> {p.value}
        </span>
      ))}
    </p>
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
      meta: { className: "whitespace-nowrap tabular-nums" },
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
      cell: ({ row }) => row.original.client_ip || <span className="font-sans text-muted-foreground/70">Unknown</span>,
      meta: { className: "whitespace-nowrap font-mono text-xs" },
    }),
    columnHelper.display({
      id: "detail",
      header: "Details",
      cell: ({ row }) => <AuditDetail action={row.original.action} detail={row.original.detail} />,
      meta: { className: "max-w-96 text-[13px] text-muted-foreground" },
    }),
  ]);
}

const NO_ROWS: AuditRow[] = [];

function toAuditRows(data: { rows: AuditRecord[] }): AuditRow[] {
  const list = Array.isArray(data?.rows) ? data.rows : [];
  return list.map((r) => ({
    id: Number(r.id ?? 0),
    ts: r.ts,
    actor: String(r.actor ?? "operator"),
    client_ip: r.client_ip,
    agent_id: r.agent_id,
    action: String(r.action ?? "unknown"),
    status: String(r.status ?? "ok"),
    detail: r.detail,
  }));
}

export function AuditTab({
  agentId,
  scope = "all",
  colorizeStatus = true,
  title = "Audit log",
  subheader,
}: AuditTabProps) {
  const [statusFilter, setStatusFilter] = useState(STATUS_OPTIONS[0]);
  const auditQuery = useQuery({
    ...auditQueries.log({
      limit: 500,
      agent_id: agentId,
      status: statusFilter.value !== "all" ? statusFilter.value : undefined,
    }),
    select: toAuditRows,
    // Keep the current rows up while a new status filter loads (never another agent's rows).
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[2] as AuditLogParams | undefined)?.agent_id === agentId ? previous : undefined,
  });
  const rows = auditQuery.data ?? NO_ROWS;
  const loading = auditQuery.isFetching;
  const fetchAudit = () => auditQuery.refetch();

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
            <span className="text-sm text-muted-foreground tabular-nums">({scopedRows.length})</span>
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
        <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
          <DataTablePagination table={table} />
        </div>
      </div>
    </div>
  );
}
