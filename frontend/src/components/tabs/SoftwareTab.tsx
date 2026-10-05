import { Search, X, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCollection } from "../../hooks/useCollection";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { AgentInfo, AgentSoftwareRow, DashboardRole } from "../../lib/types";
import { capabilityAvailable } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";
import {
  compareInstallDateSortKeys,
  fmtDateTime,
  formatWindowsInstallDate,
  installDateSortKey,
} from "../../lib/utils";

type SoftwareRow = AgentSoftwareRow & {
  id: string;
  install_date_sort: string;
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

type SortField = "name" | "publisher_sort" | "install_date_sort";

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

export function SoftwareTab({ agentId, agentInfo, dashboardRole = null, onNotifyInfo, onNotifyError }: SoftwareTabProps) {
  const [rows, setRows] = useState<SoftwareRow[]>([]);
  const [lastCaptured, setLastCaptured] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filteringText, setFilteringText] = useState("");
  const [sortField, setSortField] = useState<SortField>("install_date_sort");
  const [sortDesc, setSortDesc] = useState(true);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const data = await api.agentSoftware(agentId);
      setRows(
        (data.rows ?? []).map((r, idx) => ({
          ...r,
          id: `${idx}-${r.name}`,
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

  const filteredRows = useMemo(() => {
    const q = filteringText.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.version ?? "").toLowerCase().includes(q) ||
        (item.publisher ?? "").toLowerCase().includes(q),
    );
  }, [rows, filteringText]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    if (sortField === "install_date_sort") {
      list.sort((a, b) =>
        compareInstallDateSortKeys(a.install_date_sort, b.install_date_sort, sortDesc),
      );
    } else if (sortField === "name") {
      list.sort((a, b) => {
        const c = a.name.localeCompare(b.name);
        return sortDesc ? -c : c;
      });
    } else if (sortField === "publisher_sort") {
      list.sort((a, b) => {
        const c = a.publisher_sort.localeCompare(b.publisher_sort);
        return sortDesc ? -c : c;
      });
    }
    return list;
  }, [filteredRows, sortField, sortDesc]);

  const { items, paginationProps, actions } = useCollection(sortedRows, {
    pagination: { pageSize: 50 },
  });

  if (!softwareAvailable) {
    return <CapabilityNotice info={agentInfo} capability="software_inventory" title="Inventory unavailable" />;
  }

  const sortTh = (label: string, field: SortField) => {
    const active = sortField === field;
    return (
      <TableHead aria-sort={active ? (sortDesc ? "descending" : "ascending") : undefined}>
        <button
          type="button"
          onClick={() => {
            if (active) {
              setSortDesc((d) => !d);
            } else {
              setSortField(field);
              setSortDesc(field === "install_date_sort");
            }
            actions.setCurrentPage(1);
          }}
          className="inline-flex items-center gap-1.5 hover:text-foreground"
          aria-label={`Sort by ${label}`}
        >
          {label}
          {active && <span aria-hidden="true">{sortDesc ? "↓" : "↑"}</span>}
        </button>
      </TableHead>
    );
  };

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
              onChange={(e) => {
                setFilteringText(e.target.value);
                actions.setCurrentPage(1);
              }}
            />
            {filteringText && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={() => {
                    setFilteringText("");
                    actions.setCurrentPage(1);
                  }}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <p className="pt-1.5 text-xs text-muted-foreground">{filteredRows.length} matches</p>
        </div>
        <div className="px-2 py-2">
          <Table>
            <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                {sortTh("Name", "name")}
                <TableHead>Version</TableHead>
                {sortTh("Publisher", "publisher_sort")}
                {sortTh("Install date", "install_date_sort")}
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
              {loading && items.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4}>
                    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                      <Spinner /> Loading…
                    </div>
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4}>
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No inventory yet.
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.name}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{i.version || "—"}</TableCell>
                    <TableCell>{i.publisher || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatWindowsInstallDate(i.install_date ?? null)}</TableCell>
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
    </div>
  );
}
