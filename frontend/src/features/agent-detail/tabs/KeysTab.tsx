import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentQueries } from "@/api/queries/agents";
import { fmtDateTime } from "@/lib/utils";
import { prettyAppLabel } from "@/lib/appNames";
import { AppIcon } from "@/components/common/AppIcon";
import type { AgentInfo, KeySession } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";

interface KeystrokeEvent {
  id: number;
  exe_name: string;
  app_display?: string;
  window_title: string;
  keys: string;
  timestamp: string;
  user?: string | null;
}

interface KeysTabProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
}

function applyBackspaceCorrection(text: string): string {
  const stack: string[] = [];
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("[⌫]", i)) {
      if (stack.length > 0) stack.pop();
      i += 3;
    } else if (text.startsWith("[Del]", i)) {
      i += 5;
    } else {
      stack.push(text[i]);
      i++;
    }
  }

  return stack.join("");
}

function matchesKeystroke(item: KeystrokeEvent, filteringText: string): boolean {
  const searchText = filteringText.toLowerCase();
  return (
    (item.app_display || "").toLowerCase().includes(searchText) ||
    (item.exe_name || "").toLowerCase().includes(searchText) ||
    (item.window_title || "").toLowerCase().includes(searchText) ||
    (item.keys || "").toLowerCase().includes(searchText) ||
    (item.user || "").toLowerCase().includes(searchText)
  );
}

const columnHelper = createDataTableColumns<KeystrokeEvent>();

function keystrokeColumns(agentId: string, showCorrected: boolean) {
  return columnHelper.columns([
    columnHelper.accessor((item) => item.user ?? undefined, {
      id: "user",
      header: ({ column }) => <DataTableColumnHeader column={column} title="User" />,
      cell: ({ row }) => row.original.user || "—",
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("timestamp", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row }) => fmtDateTime(row.original.timestamp),
      meta: { className: "whitespace-nowrap font-mono text-xs tabular-nums" },
    }),
    columnHelper.accessor("exe_name", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Application" />,
      cell: ({ row, table }) => {
        const item = row.original;
        return (
          <>
            <div className="flex items-center gap-2">
              <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
              <button
                type="button"
                onClick={() => table.setGlobalFilter(item.exe_name ?? "")}
                title="Filter table by this app"
                className="inline-flex min-h-6 cursor-pointer items-center p-0 text-left hover:underline"
              >
                {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
              </button>
            </div>
            <div className="font-mono text-xs text-muted-foreground">
              {item.exe_name}
            </div>
          </>
        );
      },
    }),
    columnHelper.accessor("window_title", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Window" />,
      meta: { className: "max-w-64 text-[13px] whitespace-normal wrap-break-word" },
    }),
    columnHelper.display({
      id: "keys",
      header: "Keystrokes",
      cell: ({ row }) => (showCorrected ? applyBackspaceCorrection(row.original.keys || "") : row.original.keys || ""),
      meta: { className: "max-w-80 font-mono text-xs whitespace-normal wrap-break-word" },
    }),
  ]);
}

const KEYS_PAGE = { limit: 500 };
const NO_KEYSTROKES: KeystrokeEvent[] = [];

function toKeystrokeEvents({ rows }: { rows: KeySession[] }): KeystrokeEvent[] {
  return rows.map((row, i) => ({
    // The keystrokes endpoint returns no per-row id, so the table's row key
    // falls back to the index. Give every row a distinct composite key:
    // an id of 0 here makes every row share the key "0", which React
    // reports as a duplicate-key error and mishandles on re-render.
    id: i + 1,
    exe_name: row.app ?? "—",
    app_display: row.app_display?.trim() ? row.app_display : (row.app ?? "—"),
    window_title: row.window_title ?? "—",
    keys: row.text ?? "",
    timestamp: row.updated_at || row.started_at || "",
    user: row.user ?? null,
  }));
}

export function KeysTab({ agentId, agentInfo }: KeysTabProps) {
  const [showCorrected, setShowCorrected] = useState(false);
  const keysAvailable = capabilityAvailable(agentInfo, "keyboard_monitor");
  const keysQuery = useQuery({
    ...agentQueries.keys(agentId, KEYS_PAGE),
    enabled: keysAvailable,
    select: toKeystrokeEvents,
  });
  const items = keysQuery.data ?? NO_KEYSTROKES;
  const loading = keysQuery.isFetching;

  const columns = useMemo(() => keystrokeColumns(agentId, showCorrected), [agentId, showCorrected]);
  const table = useDataTable({
    data: items,
    columns,
    initialSorting: [{ id: "timestamp", desc: true }],
    filterFn: matchesKeystroke,
  });
  const filteringText = String(table.state.globalFilter ?? "");

  if (!keysAvailable) {
    return <CapabilityNotice info={agentInfo} capability="keyboard_monitor" title="Keystrokes unavailable" />;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <h2 className="font-heading text-base font-medium">
          Entries{" "}
          <span className="font-mono text-sm text-muted-foreground">({items.length})</span>
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={showCorrected}
              onCheckedChange={(checked) => setShowCorrected(checked === true)}
              aria-label="Show corrected keystrokes"
            />
            Show corrected
          </label>
          <Button variant="outline" size="sm" onClick={() => void keysQuery.refetch()}>
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
            aria-label="Search keystrokes"
            placeholder="App, window, or text"
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
          loadingText="Loading keystrokes…"
          emptyText="No keystrokes yet"
          bodyClassName="[&_td]:align-top"
        />
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1">
        <DataTablePagination table={table} />
      </div>
    </div>
  );
}
