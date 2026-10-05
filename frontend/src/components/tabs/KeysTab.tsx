import { Search, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCollection, type UseCollectionCollectionProps } from "../../hooks/useCollection";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { prettyAppLabel } from "../../lib/app-names";
import { AppIcon } from "../common/AppIcon";
import type { AgentInfo } from "../../lib/types";
import { capabilityAvailable } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";

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

function Pager({ currentPageIndex, pagesCount, onChange }: {
  currentPageIndex: number;
  pagesCount: number;
  onChange: (event: { detail: { currentPageIndex: number } }) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={currentPageIndex <= 1}
        onClick={() => onChange({ detail: { currentPageIndex: currentPageIndex - 1 } })}
      >
        Previous
      </Button>
      <span className="px-3 text-[13px] text-muted-foreground tabular-nums">
        Page {currentPageIndex} of {pagesCount}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={currentPageIndex >= pagesCount}
        onClick={() => onChange({ detail: { currentPageIndex: currentPageIndex + 1 } })}
      >
        Next
      </Button>
    </div>
  );
}

function SortTh({ label, field, collectionProps }: {
  label: string;
  field: string;
  collectionProps: UseCollectionCollectionProps;
}) {
  const { sortingColumn, isDescending, onSortingChange } = collectionProps;
  const active = sortingColumn?.sortingField === field;
  return (
    <TableHead aria-sort={active ? (isDescending ? "descending" : "ascending") : undefined}>
      <button
        type="button"
        onClick={() => onSortingChange({
          detail: {
            sortingColumn: { sortingField: field },
            isDescending: active ? !isDescending : false,
          },
        })}
        className="inline-flex items-center gap-1.5 hover:text-foreground"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active && <span aria-hidden="true">{isDescending ? "↓" : "↑"}</span>}
      </button>
    </TableHead>
  );
}

export function KeysTab({ agentId, agentInfo }: KeysTabProps) {
  const [items, setItems] = useState<KeystrokeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCorrected, setShowCorrected] = useState(false);
  const keysAvailable = capabilityAvailable(agentInfo, "keyboard_monitor");

  const fetchKeystrokes = useCallback(async () => {
    if (!keysAvailable) {
      setItems([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const { rows } = await api.keys(agentId, { limit: 500 });
      setItems(
        rows.map((row, i) => ({
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
        })),
      );
    } catch (err) {
      console.error("Failed to fetch keystrokes:", err);
    } finally {
      setLoading(false);
    }
  }, [agentId, keysAvailable]);

  useEffect(() => {
    void fetchKeystrokes();
  }, [fetchKeystrokes]);

  const applyBackspaceCorrection = (text: string): string => {
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
  };

  const { items: displayItems, collectionProps, filterProps, paginationProps } = useCollection(
    items,
    {
      filtering: {
        empty: "No keystrokes yet",
        noMatch: "No matches",
        filteringFunction: (item, filteringText) => {
          const searchText = filteringText.toLowerCase();
          return (
            (item.app_display || "").toLowerCase().includes(searchText) ||
            (item.exe_name || "").toLowerCase().includes(searchText) ||
            (item.window_title || "").toLowerCase().includes(searchText) ||
            (item.keys || "").toLowerCase().includes(searchText) ||
            (item.user || "").toLowerCase().includes(searchText)
          );
        },
      },
      pagination: { pageSize: 50 },
      sorting: {
        defaultState: {
          sortingColumn: { sortingField: "timestamp" },
          isDescending: true,
        },
      },
    }
  );

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
          <Button variant="outline" size="sm" onClick={() => void fetchKeystrokes()}>
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
            value={filterProps.filteringText}
            onChange={(e) => filterProps.onChange({ detail: { filteringText: e.target.value } })}
          />
          {filterProps.filteringText && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => filterProps.onChange({ detail: { filteringText: "" } })}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <div className="px-2 py-2">
        <Table>
          <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <SortTh label="User" field="user" collectionProps={collectionProps} />
              <SortTh label="Time" field="timestamp" collectionProps={collectionProps} />
              <SortTh label="Application" field="exe_name" collectionProps={collectionProps} />
              <SortTh label="Window" field="window_title" collectionProps={collectionProps} />
              <TableHead>Keystrokes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-3.5 [&_td]:align-top">
            {loading && displayItems.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Spinner /> Loading keystrokes…
                  </div>
                </TableCell>
              </TableRow>
            ) : displayItems.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No keystrokes yet
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              displayItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">{item.user || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">{fmtDateTime(item.timestamp)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
                      <button
                        type="button"
                        onClick={() =>
                          filterProps.onChange({
                            detail: { filteringText: item.exe_name ?? "" },
                          } as Parameters<typeof filterProps.onChange>[0])
                        }
                        title="Filter table by this app"
                        className="inline-flex min-h-6 cursor-pointer items-center p-0 text-left hover:underline"
                      >
                        {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
                      </button>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {item.exe_name}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 text-[13px] whitespace-normal wrap-break-word">{item.window_title}</TableCell>
                  <TableCell className="max-w-80 font-mono text-xs whitespace-normal wrap-break-word">
                    {showCorrected ? applyBackspaceCorrection(item.keys || "") : item.keys || ""}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1">
        <Pager {...paginationProps} />
      </div>
    </div>
  );
}
