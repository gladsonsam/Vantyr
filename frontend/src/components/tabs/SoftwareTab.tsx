import { Box, Button, Header, SpaceBetween, Table, TableProps, Pagination, TextFilter, useCollection } from "../ui/console";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { AgentSoftwareRow } from "../../lib/types";
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
  onNotifyInfo?: (header: string, content?: string) => void;
  onNotifyError?: (header: string, content?: string) => void;
}

export function SoftwareTab({ agentId, onNotifyInfo, onNotifyError }: SoftwareTabProps) {
  const [rows, setRows] = useState<SoftwareRow[]>([]);
  const [lastCaptured, setLastCaptured] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filteringText, setFilteringText] = useState("");

  const columnDefinitions = useMemo<TableProps.ColumnDefinition<SoftwareRow>[]>(
    () => [
      { id: "name", header: "Name", cell: (i) => i.name, sortingField: "name" },
      { id: "version", header: "Version", cell: (i) => i.version || "—" },
      {
        id: "publisher",
        header: "Publisher",
        cell: (i) => i.publisher || "—",
        sortingField: "publisher_sort",
      },
      {
        id: "install_date",
        header: "Install date",
        cell: (i) => formatWindowsInstallDate(i.install_date ?? null),
        sortingField: "install_date_sort",
      },
    ],
    [],
  );

  const [sortingState, setSortingState] = useState<TableProps.SortingState<SoftwareRow>>(() => ({
    sortingColumn: columnDefinitions.find((c) => c.id === "install_date")!,
    isDescending: true,
  }));

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
    setCollecting(true);
    setErr(null);
    try {
      await api.collectAgentSoftware(agentId);
      onNotifyInfo?.("Inventory refresh started", "Waiting for the agent to upload software data…");
      await new Promise((r) => setTimeout(r, 2500));
      await load();
      onNotifyInfo?.("Software inventory updated", "Latest rows are shown below.");
    } catch (e) {
      const msg = String(e);
      setErr(msg);
      onNotifyError?.("Could not refresh software inventory", msg);
    } finally {
      setCollecting(false);
    }
  };

  const canRefresh = !loading || collecting;

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
    const field = sortingState.sortingColumn.sortingField;
    const desc = sortingState.isDescending ?? false;
    if (field === "install_date_sort") {
      list.sort((a, b) =>
        compareInstallDateSortKeys(a.install_date_sort, b.install_date_sort, desc),
      );
    } else if (field === "name") {
      list.sort((a, b) => {
        const c = a.name.localeCompare(b.name);
        return desc ? -c : c;
      });
    } else if (field === "publisher_sort") {
      list.sort((a, b) => {
        const c = a.publisher_sort.localeCompare(b.publisher_sort);
        return desc ? -c : c;
      });
    }
    return list;
  }, [filteredRows, sortingState]);

  const { items, collectionProps, paginationProps, actions } = useCollection(sortedRows, {
    pagination: { pageSize: 50 },
  });

  return (
    <SpaceBetween size="l">
      <Header
        variant="h2"
        description="Installed programs from the agent’s Windows registry (Uninstall keys). Refreshed daily while online, or on demand below."
        actions={
          canRefresh ? (
            <Button
              variant="primary"
              loading={collecting}
              onClick={() => void onCollect()}
            >
              Refresh
            </Button>
          ) : (
            <Box fontSize="body-s" color="text-body-secondary">
              Loading…
            </Box>
          )
        }
      >
        Installed software
      </Header>
      {lastCaptured && (
        <Box variant="p" color="text-body-secondary">
          Last inventory stored: {fmtDateTime(lastCaptured)}
        </Box>
      )}
      {err && (
        <Box variant="p" color="text-status-error">
          {err}
        </Box>
      )}
      <Table
        {...collectionProps}
        columnDefinitions={columnDefinitions}
        trackBy="id"
        sortingColumn={sortingState.sortingColumn}
        sortingDescending={sortingState.isDescending}
        onSortingChange={({ detail }) => {
          const sf = detail.sortingColumn.sortingField;
          const col =
            columnDefinitions.find((c) => c.sortingField === sf) ??
            columnDefinitions.find((c) => c.id === "install_date")!;
          setSortingState({ sortingColumn: col, isDescending: detail.isDescending ?? false });
          actions.setCurrentPage(1);
        }}
        items={items}
        loading={loading}
        loadingText="Loading software inventory"
        filter={
          <TextFilter
            filteringText={filteringText}
            onChange={({ detail }) => {
              setFilteringText(detail.filteringText);
              actions.setCurrentPage(1);
            }}
            filteringPlaceholder="Find software"
            countText={`${filteredRows.length} matches`}
          />
        }
        pagination={<Pagination {...paginationProps} />}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="l">
            No inventory yet. The agent sends a list about a minute after connecting, then once per day, or use
            Refresh (agent must be online).
          </Box>
        }
      />
    </SpaceBetween>
  );
}
