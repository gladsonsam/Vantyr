import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Button } from "@vantyr/ui/components/button";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentQueries } from "@/api/queries/agents";
import { cn } from "@/lib/utils";
import { prettyAppLabel } from "@/lib/appNames";
import { AppIcon } from "@/components/common/AppIcon";
import type { AgentInfo, KeySession } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import {
  LoadFailed,
  MonitoringToolbar,
} from "@/features/agent-detail/components/MonitoringToolbar";
import {
  isLongText,
  listCountLabel,
  titleRestatesApp,
} from "@/features/agent-detail/lib/monitoring";
import { DayTimeCell } from "@/components/common/data-table/DayTimeCell";

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

/** Typed text, folded after a few lines so one long session doesn't push every other row off screen. */
function TypedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return <span className="text-muted-foreground">No text kept</span>;
  const long = isLongText(text);
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        id={id}
        className={cn(
          "max-w-full whitespace-pre-wrap break-words",
          long && !open && "line-clamp-3",
        )}
      >
        {text}
      </div>
      {long ? (
        <Button
          variant="ghost"
          size="xs"
          className="-ml-2 h-7 font-sans pointer-coarse:h-9"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
        </Button>
      ) : null}
    </div>
  );
}

const columnHelper = createDataTableColumns<KeystrokeEvent>();

function keystrokeColumns(agentId: string, showCorrected: boolean) {
  return columnHelper.columns([
    columnHelper.accessor((item) => item.user ?? undefined, {
      id: "user",
      header: ({ column }) => <DataTableColumnHeader column={column} title="User" />,
      cell: ({ row }) => row.original.user || "—",
      meta: { className: "whitespace-nowrap", hideWhenUniform: true },
    }),
    columnHelper.accessor("timestamp", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Time" />,
      cell: ({ row, table }) => (
        <DayTimeCell table={table} columnId="timestamp" ts={row.original.timestamp} />
      ),
      meta: { className: "whitespace-nowrap text-[13px] text-muted-foreground tabular-nums" },
    }),
    columnHelper.accessor("exe_name", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Application" />,
      cell: ({ row, table }) => {
        const item = row.original;
        return (
          <div className="flex items-center gap-2">
            <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
            <button
              type="button"
              onClick={() => table.setGlobalFilter(item.exe_name ?? "")}
              title={`Only show ${item.exe_name}`}
              className="inline-flex min-h-7 cursor-pointer items-center p-0 text-left hover:underline max-sm:min-h-7 pointer-coarse:min-h-9"
            >
              {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
            </button>
          </div>
        );
      },
      meta: { className: "whitespace-nowrap" },
    }),
    columnHelper.accessor("window_title", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Window" />,
      // A window called just like its app adds nothing to the row.
      cell: ({ row }) => {
        const item = row.original;
        return titleRestatesApp(item.window_title, item.app_display, item.exe_name)
          ? null
          : item.window_title;
      },
      meta: {
        className:
          "max-w-56 text-[13px] text-muted-foreground whitespace-normal wrap-break-word max-sm:basis-full",
      },
    }),
    columnHelper.display({
      id: "keys",
      header: "Typed text",
      cell: ({ row }) => (
        <TypedText
          text={
            showCorrected
              ? applyBackspaceCorrection(row.original.keys || "")
              : row.original.keys || ""
          }
        />
      ),
      meta: {
        className:
          "min-w-64 max-w-xl font-sans text-xs whitespace-normal wrap-break-word max-sm:order-first max-sm:basis-full",
      },
    }),
  ]);
}

const KEYS_LIMIT = 500;
const KEYS_PAGE = { limit: KEYS_LIMIT };
const SESSIONS = { one: "typing session", many: "typing sessions" };
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
  // Typed text reads as typed (backspaces applied); the raw key stream is opt-in.
  const [showRaw, setShowRaw] = useState(false);
  const showCorrected = !showRaw;
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
    return (
      <CapabilityNotice
        info={agentInfo}
        capability="keyboard_monitor"
        title="Keystrokes unavailable"
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card">
      <MonitoringToolbar
        title="Typed text"
        searchLabel="Search keystrokes"
        placeholder="Search typing"
        query={filteringText}
        onQueryChange={table.setGlobalFilter}
        count={listCountLabel({
          shown: table.getFilteredRowModel().rows.length,
          loaded: items.length,
          limit: KEYS_LIMIT,
          noun: SESSIONS,
        })}
        onRefresh={() => void keysQuery.refetch()}
        refreshing={loading && items.length > 0}
        actions={
          <label
            className="flex cursor-pointer items-center gap-2 px-1 text-sm text-muted-foreground"
            title="Show every key press, including backspaces, instead of the text as typed"
          >
            <Checkbox
              checked={showRaw}
              onCheckedChange={(checked) => setShowRaw(checked === true)}
              aria-label="Show raw keys"
            />
            Raw keys
          </label>
        }
      />
      {keysQuery.isError ? (
        <LoadFailed what="typed text" onRetry={() => void keysQuery.refetch()} />
      ) : null}
      <div className="px-2 py-2">
        <DataTable
          dayGroupColumn="timestamp"
          table={table}
          loading={loading}
          loadingText="Loading keystrokes…"
          emptyText={
            keysQuery.isError
              ? "Nothing to show."
              : filteringText
                ? "No typing matches this search."
                : "No keystrokes recorded yet."
          }
          bodyClassName="[&_td]:align-top"
        />
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
        <DataTablePagination table={table} />
      </div>
    </div>
  );
}
