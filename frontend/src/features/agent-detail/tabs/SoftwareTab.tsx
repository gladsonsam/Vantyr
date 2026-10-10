import { Search, X, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Spinner } from "@vantyr/ui/components/spinner";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys, agentQueries } from "@/api/queries/agents";
import type { AgentInfo, AgentSoftwareRow, DashboardRole } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
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
    meta: { className: "whitespace-nowrap tabular-nums" },
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

const NO_SOFTWARE: SoftwareRow[] = [];

function toSoftwareInventory(data: { rows?: AgentSoftwareRow[]; last_captured_at?: string | null }) {
  return {
    rows: (data.rows ?? []).map((r): SoftwareRow => ({
      ...r,
      install_date_sort: installDateSortKey(r.install_date ?? null),
      publisher_sort: r.publisher ?? "",
    })),
    lastCaptured: data.last_captured_at ?? null,
  };
}

export function SoftwareTab({ agentId, agentInfo, dashboardRole = null, onNotifyInfo, onNotifyError }: SoftwareTabProps) {
  const queryClient = useQueryClient();
  const softwareQuery = useQuery({ ...agentQueries.software(agentId), select: toSoftwareInventory });
  // A failed load clears the table rather than leaving the last inventory up.
  const rows = softwareQuery.isError ? NO_SOFTWARE : softwareQuery.data?.rows ?? NO_SOFTWARE;
  const lastCaptured = softwareQuery.isError ? null : softwareQuery.data?.lastCaptured ?? null;
  const loading = softwareQuery.isFetching;

  const collect = useMutation({
    mutationFn: async () => {
      await api.collectAgentSoftware(agentId);
      onNotifyInfo?.("Refreshing inventory", "Waiting for agent…");
      await new Promise((r) => setTimeout(r, 2500));
      await queryClient.invalidateQueries({ queryKey: agentKeys.software(agentId) });
      onNotifyInfo?.("Inventory updated");
    },
    onError: (e) => onNotifyError?.("Refresh failed", String(e)),
  });
  const collecting = collect.isPending;
  const err = collect.error ? String(collect.error) : softwareQuery.error ? String(softwareQuery.error) : null;

  const onCollect = () => {
    if (dashboardRole === "viewer") return;
    collect.mutate();
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
            onClick={onCollect}
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
        <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
          <DataTablePagination table={table} />
        </div>
      </div>
    </div>
  );
}
