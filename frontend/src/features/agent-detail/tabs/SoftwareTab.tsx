import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import {
  DataTableSortSelect,
  type SortChoice,
} from "@/components/common/data-table/DataTableSortSelect";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { HelpTip } from "@/components/common/HelpTip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys, agentQueries } from "@/api/queries/agents";
import type { AgentInfo, AgentSoftwareRow, DashboardRole } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import {
  LoadFailed,
  MonitoringToolbar,
} from "@/features/agent-detail/components/MonitoringToolbar";
import { listCountLabel } from "@/features/agent-detail/lib/monitoring";
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
    cell: ({ row }) => (
      <span className="wrap-break-word" title={row.original.install_location || undefined}>
        {row.original.name}
      </span>
    ),
    // max-w-0 + w-full: the name takes the leftover width and wraps, instead of one long name widening the table.
    meta: { className: "font-medium sm:w-full sm:max-w-0 max-sm:order-first max-sm:basis-full" },
  }),
  columnHelper.accessor("version", {
    header: "Version",
    enableSorting: false,
    cell: ({ row }) => row.original.version || "—",
    meta: {
      className: "whitespace-nowrap tabular-nums max-sm:text-muted-foreground",
      label: "Version",
    },
  }),
  columnHelper.accessor("publisher_sort", {
    header: ({ column }) => <DataTableColumnHeader column={column} title="Publisher" />,
    cell: ({ row }) => row.original.publisher || "—",
    meta: { className: "max-sm:text-muted-foreground" },
  }),
  columnHelper.accessor("install_date_sort", {
    header: ({ column }) => <DataTableColumnHeader column={column} title="Installed" />,
    cell: ({ row }) => formatWindowsInstallDate(row.original.install_date ?? null),
    sortDescFirst: true,
    meta: {
      className: "whitespace-nowrap tabular-nums max-sm:text-muted-foreground",
      label: "Installed",
    },
  }),
]);

const SORT_CHOICES: SortChoice[] = [
  { id: "install_date_sort", desc: true, label: "Newest installed" },
  { id: "install_date_sort", desc: false, label: "Oldest installed" },
  { id: "name", desc: false, label: "Name A–Z" },
  { id: "name", desc: true, label: "Name Z–A" },
  { id: "publisher_sort", desc: false, label: "Publisher A–Z" },
];

const PROGRAMS = { one: "program", many: "programs" };

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

function toSoftwareInventory(data: {
  rows?: AgentSoftwareRow[];
  last_captured_at?: string | null;
}) {
  return {
    rows: (data.rows ?? []).map((r): SoftwareRow => ({
      ...r,
      install_date_sort: installDateSortKey(r.install_date ?? null),
      publisher_sort: r.publisher ?? "",
    })),
    lastCaptured: data.last_captured_at ?? null,
  };
}

export function SoftwareTab({
  agentId,
  agentInfo,
  dashboardRole = null,
  onNotifyInfo,
  onNotifyError,
}: SoftwareTabProps) {
  const queryClient = useQueryClient();
  const softwareQuery = useQuery({
    ...agentQueries.software(agentId),
    select: toSoftwareInventory,
  });
  // A failed load clears the table rather than leaving the last inventory up.
  const rows = softwareQuery.isError ? NO_SOFTWARE : (softwareQuery.data?.rows ?? NO_SOFTWARE);
  const lastCaptured = softwareQuery.isError ? null : (softwareQuery.data?.lastCaptured ?? null);
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

  const canCollect = dashboardRole !== "viewer";
  const onCollect = () => {
    if (!canCollect) return;
    collect.mutate();
  };
  const softwareAvailable = capabilityAvailable(agentInfo, "software_inventory");

  const table = useDataTable({
    data: rows,
    columns,
    initialSorting: [{ id: "install_date_sort", desc: true }],
    filterFn: matchesSoftware,
  });
  const filteringText = String(table.state.globalFilter ?? "");

  if (!softwareAvailable) {
    return (
      <CapabilityNotice
        info={agentInfo}
        capability="software_inventory"
        title="Inventory unavailable"
      />
    );
  }

  const count = listCountLabel({
    shown: table.getFilteredRowModel().rows.length,
    loaded: rows.length,
    limit: Number.POSITIVE_INFINITY,
    noun: PROGRAMS,
  });
  const emptyText = filteringText.trim()
    ? `No software matches “${filteringText.trim()}”.`
    : canCollect
      ? "No inventory yet. Use Re-scan (top right) to collect the installed software."
      : "No inventory yet. An operator can re-scan this device.";

  return (
    <div className="flex flex-col gap-4">
      {collect.error && (
        <Alert variant="destructive">
          <AlertDescription>Re-scan failed. {String(collect.error)}</AlertDescription>
        </Alert>
      )}
      <div className="overflow-hidden rounded-xl bg-card pb-2">
        <MonitoringToolbar
          title="Installed software"
          searchLabel="Find software"
          placeholder="Find by name, version or publisher"
          query={filteringText}
          onQueryChange={table.setGlobalFilter}
          count={softwareQuery.isError ? "" : count}
          detail={
            <>
              {lastCaptured ? <span>Updated {fmtDateTime(lastCaptured)}</span> : null}
              <HelpTip label="About this list" className="max-sm:-my-2 max-sm:size-9">
                The device sends its installed software once a day while it is online. Re-scan asks
                it to send the list now.
              </HelpTip>
              <DataTableSortSelect
                table={table}
                choices={SORT_CHOICES}
                className="ml-auto w-40 sm:hidden"
              />
            </>
          }
          onRefresh={onCollect}
          refreshing={collecting || loading}
          refreshDisabled={!canCollect}
          refreshLabel={canCollect ? "Re-scan this device" : "Re-scan needs the operator role"}
        />
        {softwareQuery.isError ? (
          <LoadFailed what="the software list" onRetry={() => void softwareQuery.refetch()} />
        ) : null}
        <div className="px-2 pt-2">
          <DataTable
            table={table}
            loading={loading}
            loadingText="Loading software…"
            emptyText={emptyText}
          />
        </div>
        <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
          <DataTablePagination table={table} />
        </div>
      </div>
    </div>
  );
}
