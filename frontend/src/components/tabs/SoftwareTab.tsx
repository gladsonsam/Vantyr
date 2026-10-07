import { Search, X, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import type { AgentInfo, AgentSoftwareRow, DashboardRole } from "@/api/types";
import { capabilityAvailable } from "@/lib/agentCapabilities";
import { CapabilityNotice } from "@/components/common/CapabilityNotice";
import { fmtDateTime, formatWindowsInstallDate, installDateSortKey } from "@/lib/utils";

type SoftwareRow = AgentSoftwareRow & {
  /** `YYYYMMDD`, or undefined when unknown so undated rows sort last. */
  install_date_sort: string | undefined;
  /** Stable string for table sort (publisher may be null from API). */
  publisher_sort: string;
};

interface SoftwareTabProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
  dashboardRole?: DashboardRole | null;
  onNotifyInfo?: (header: string, content?: string) => void;
  onNotifyError?: (header: string, content?: string) => void;
}

const columnHelper = createDataTableColumns<SoftwareRow>();
const columns = columnHelper.columns([
  columnHelper.accessor("name", {
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
  }),
  columnHelper.accessor("version", {
    header: "Version",
    enableSorting: false,
    cell: ({ row }) => row.original.version || "—",
    meta: { className: "font-mono text-xs whitespace-nowrap" },
  }),
  columnHelper.accessor("publisher_sort", {
    header: ({ column }) => <DataTableColumnHeader column={column} title="Publisher" />,
    cell: ({ row }) => row.original.publisher || "—",
  }),
  columnHelper.accessor("install_date_sort", {
    header: ({ column }) => <DataTableColumnHeader column={column} title="Install date" />,
    cell: ({ row }) => formatWindowsInstallDate(row.original.install_date ?? null),
    sortDescFirst: true,
    meta: { className: "whitespace-nowrap" },
  }),
]);

function matchesSoftware(item: SoftwareRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.name.toLowerCase().includes(q) ||
    (item.version ?? "").toLowerCase().includes(q) ||
    (item.publisher ?? "").toLowerCase().includes(q)
  );
}

export function SoftwareTab({ agentId, agentInfo, dashboardRole = null, onNotifyInfo, onNotifyError }: SoftwareTabProps) {
  const [rows, setRows] = useState<SoftwareRow[]>([]);
  const [lastCaptured, setLastCaptured] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const data = await api.agentSoftware(agentId);
      setRows(
        (data.rows ?? []).map((r) => ({
          ...r,
          install_date_sort: installDateSortKey(r.install_date ?? null),
          publisher_sort: r.publisher ?? "",
        })),
      );
      setLastCaptured(data.last_captured_at ?? null);
    } catch (e) {
      setErr(String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCollect = async () => {
    if (dashboardRole === "viewer") return;
    setCollecting(true);
    setErr(null);
    try {
      await api.collectAgentSoftware(agentId);
      onNotifyInfo?.("Refreshing inventory", "Waiting for agent…");
      await new Promise((r) => setTimeout(r, 2500));
      await load();
      onNotifyInfo?.("Inventory updated");
    } catch (e) {
      const msg = String(e);
      setErr(msg);
      onNotifyError?.("Refresh failed", msg);
    } finally {
      setCollecting(false);
    }
  };

  const canRefresh = !loading || collecting;
  const canCollect = dashboardRole !== "viewer";
  const softwareAvailable = capabilityAvailable(agentInfo, "software_inventory");

  const table = useDataTable({
    data: rows,
    columns,
    initialSorting: [{ id: "install_date_sort", desc: true }],
    filterFn: matchesSoftware,
  });
  const filteringText = String(table.state.globalFilter ?? "");

  if (!softwareAvailable) {
    return <CapabilityNotice info={agentInfo} capability="software_inventory" title="Inventory unavailable" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm text-muted-foreground">Refreshed daily while online.</p>
          {lastCaptured && (
            <p className="text-xs text-muted-foreground">
              Updated {fmtDateTime(lastCaptured)}
            </p>
          )}
        </div>
        {canRefresh ? (
          <Button
            disabled={!canCollect || collecting}
            aria-label={canCollect ? undefined : "Operator role required"}
            onClick={() => void onCollect()}
          >
            {collecting ? <Spinner /> : <RefreshCw />} Refresh
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">Loading…</span>
        )}
      </div>
      {err && (
        <Alert variant="destructive">
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}
      <div className="overflow-hidden rounded-xl bg-card">
        <div className="px-5 pt-4">
          <InputGroup className="h-9">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Find software"
              placeholder="Find software"
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
          <p className="pt-1.5 text-xs text-muted-foreground">{table.getFilteredRowModel().rows.length} matches</p>
        </div>
        <div className="px-2 py-2">
          <DataTable table={table} loading={loading} emptyText="No inventory yet." />
        </div>
        <div className="border-t border-foreground/[0.06] px-5 py-1">
          <DataTablePagination table={table} />
        </div>
      </div>
    </div>
  );
}
