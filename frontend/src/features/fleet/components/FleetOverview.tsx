import { EmptyState } from "@/components/common/EmptyState";
import { useMemo, useState, type ComponentProps } from "react";
import {
  FolderPlus,
  Plus,
  RotateCcw,
  SearchX,
  ServerOff,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Button } from "@vantyr/ui/components/button";
import { Skeleton } from "@vantyr/ui/components/skeleton";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { FleetStatusFilter } from "@/features/fleet/lib/fleetPreferences";
import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";
import type { FleetRow } from "@/features/fleet/types";
import { useFleetTable, type FleetTableProps } from "@/features/fleet/hooks/useFleetTable";
import type { AgentActionHandlers, PowerAction } from "./AgentActionsMenu";
import { FLEET_GRID_CLASS, FleetGridView } from "./FleetGridView";
import { FleetTableView } from "./FleetTableView";
import {
  DEFAULT_FLEET_COLUMNS,
  FLEET_COLUMNS,
  type FleetColumnId,
} from "@/features/fleet/lib/fleetColumns";
import { TablePager } from "@/components/common/data-table/TablePager";
import { paginate } from "@/components/common/data-table/pagination";
import { FleetToolbar, type StatusCounts } from "./FleetToolbar";
import { FleetStatStrip } from "./FleetStatStrip";
import { BulkScriptModal } from "./BulkScriptModal";
import { BulkAddToGroupModal } from "./BulkAddToGroupModal";
import { DeviceCard } from "@/features/devices/components/DeviceCard";
import type { DeviceRow } from "@/features/devices/lib/deviceModel";
import { connectedCount } from "@/features/devices/lib/deviceModel";
import { filterDevices } from "@/features/devices/lib/filterDevices";

interface Props extends FleetTableProps {
  loadingAgents: boolean;
  onSelectAgent: (agentId: string, tab?: TabKey, scroll?: boolean) => void;
  onAddAgent?: () => void;
  /** Devices that reach Vantyr without an agent. They share the grid with the agent devices. */
  otherDevices?: DeviceRow[];
}

const POWER_COPY: Record<
  Exclude<PowerAction, "lock" | "wake">,
  { title: string; body: string; cta: string }
> = {
  restart: {
    title: "Restart",
    body: "Anyone using the device will be signed out and unsaved work may be lost.",
    cta: "Restart device",
  },
  shutdown: {
    title: "Shut down",
    body: "The device powers off. Bring it back with Wake on LAN if it is configured and reachable.",
    cta: "Shut down device",
  },
};

/** Arcane's grid-view skeleton: outlined cards with a header row and a couple of meta lines. */
function FleetSkeleton() {
  return (
    <div className={FLEET_GRID_CLASS}>
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/10 p-4"
        >
          <div className="flex items-center gap-3 border-b border-border/40 pb-3">
            <Skeleton className="size-10 rounded-xl" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Skeleton className="col-span-2 h-8 w-full" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Loading and empty states live outside `FleetContent` so `useFleetTable` only
 * mounts once agents are loaded; its favorite pruning would otherwise discard
 * every favorite while the fleet is still empty.
 */
export function FleetOverview({ loadingAgents, onAddAgent, ...props }: Props) {
  if (loadingAgents) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-72" />
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-64 rounded-lg" />
          <Skeleton className="h-9 w-24 rounded-lg" />
          <Skeleton className="ml-auto h-9 w-20 rounded-lg" />
        </div>
        <FleetSkeleton />
      </div>
    );
  }
  if (Object.keys(props.agents).length === 0 && !props.otherDevices?.length) {
    return (
      <EmptyState
        title="No devices yet"
        description={
          onAddAgent ? "Enroll a device to see it here." : "Ask an admin to enroll a device."
        }
        icon={
          <>
            <ServerOff />
          </>
        }
        iconVariant="icon"
        action={
          onAddAgent && (
            <>
              <Button onClick={onAddAgent}>
                <Plus /> Enroll agent
              </Button>
            </>
          )
        }
      />
    );
  }
  return <FleetContent {...props} />;
}

function FleetContent(props: Omit<Props, "loadingAgents" | "onAddAgent">) {
  const { onBatchRestart, onBatchShutdown, canOperate = true, onBulkAddToGroup } = props;
  const fleet = useFleetTable(props);
  const {
    rows,
    filteredRows,
    query,
    currentFilters,
    viewMode,
    fleetSort,
    preferences,
    preferenceScope,
    favoriteIds,
    toggleFavorite,
    changeQuery,
    changeFilters,
    changeView,
    setFleetSort,
    applyView,
    updatePreferences,
    onQueryChange,
    isMobile,
    versionPayload,
    canDelete,
    selected,
    selectedIds,
    setSelected,
    toggleSelect,
    deleting,
    requestDelete,
  } = fleet;
  const [powerConfirm, setPowerConfirm] = useState<{
    row: FleetRow;
    action: "restart" | "shutdown";
  } | null>(null);
  const [bulkScriptIds, setBulkScriptIds] = useState<string[] | null>(null);
  const [bulkGroupIds, setBulkGroupIds] = useState<string[] | null>(null);
  const [columns, setColumns] = useState<ReadonlySet<FleetColumnId>>(DEFAULT_FLEET_COLUMNS);
  const [pageSize, setPageSize] = useState(20);
  // The page resets to the first whenever the filters or sort change.
  const pageSignature = [
    query,
    currentFilters.status,
    currentFilters.favoritesOnly,
    fleetSort.key,
    fleetSort.direction,
    pageSize,
  ].join("|");
  const [pageState, setPageState] = useState({ signature: pageSignature, page: 1 });
  const page = pageState.signature === pageSignature ? pageState.page : 1;
  const setPage = (next: number) => setPageState({ signature: pageSignature, page: next });
  const toggleColumn = (id: string) =>
    setColumns((previous) => {
      const next = new Set(previous);
      if (next.has(id as FleetColumnId)) next.delete(id as FleetColumnId);
      else next.add(id as FleetColumnId);
      return next;
    });

  // Devices without an agent count too, so the numbers match the cards on screen.
  const counts = useMemo(() => {
    const base = { ...countFleetStatuses(rows) };
    for (const other of props.otherDevices ?? []) {
      const live = connectedCount(other) > 0;
      base.all += 1;
      if (live) {
        base.online += 1;
        base.active += 1;
      } else base.offline += 1;
    }
    return base;
  }, [rows, props.otherDevices]);
  const updates = useMemo(() => rows.filter((row) => row.updateNeeded).length, [rows]);

  const setStatus = (status: FleetStatusFilter) => changeFilters({ status });
  const clearFilters = () => {
    changeFilters({ search: "", status: "all", favoritesOnly: false });
    onQueryChange?.("");
  };

  const handlers = createFleetActionHandlers({
    props,
    canOperate,
    canDelete,
    deleting,
    requestDelete,
    setPowerConfirm,
  });

  const viewProps = {
    rows: filteredRows,
    favoriteIds,
    onToggleFavorite: preferenceScope ? toggleFavorite : undefined,
    latestAgentVersion: versionPayload?.latest_agent_version,
    handlers,
    sort: fleetSort,
    onSort: setFleetSort,
    columns,
    selection: canDelete
      ? {
          selected,
          toggle: toggleSelect,
          setAll: (ids: string[]) => setSelected(new Set(ids)),
          disabled: deleting,
        }
      : undefined,
  };

  const filtered = Boolean(
    query.trim() || currentFilters.status !== "all" || currentFilters.favoritesOnly,
  );
  const otherDevices = filterDevices(props.otherDevices ?? [], {
    query,
    status: currentFilters.status,
    favoritesOnly: currentFilters.favoritesOnly,
  });

  return (
    <div className="flex flex-col gap-6">
      <FleetStatStrip
        counts={counts}
        updates={updates}
        status={currentFilters.status}
        onStatus={setStatus}
      />
      <FleetToolbar
        key={preferenceScope ?? "unverified"}
        current={{
          search: query,
          status: currentFilters.status,
          view: viewMode,
          sort: fleetSort,
          favoritesOnly: currentFilters.favoritesOnly,
        }}
        counts={counts}
        preferences={preferences}
        ready={Boolean(preferenceScope)}
        onSearch={changeQuery}
        onStatus={setStatus}
        onView={changeView}
        onSort={setFleetSort}
        onFavoritesOnly={(favoritesOnly) => changeFilters({ favoritesOnly })}
        onApply={applyView}
        onSave={(name) =>
          updatePreferences((previous) => ({
            ...previous,
            views: [
              ...previous.views.filter((view) => view.name !== name),
              {
                name,
                search: query,
                status: currentFilters.status,
                view: viewMode,
                sort: fleetSort,
                favoritesOnly: currentFilters.favoritesOnly,
              },
            ],
          }))
        }
        onRemove={(name) =>
          updatePreferences((previous) => ({
            ...previous,
            views: previous.views.filter((view) => view.name !== name),
          }))
        }
        onClear={clearFilters}
        columns={FLEET_COLUMNS.map((column) => ({
          id: column.id,
          label: column.label,
          visible: columns.has(column.id),
        }))}
        onToggleColumn={toggleColumn}
      />

      <FleetRows
        viewProps={viewProps}
        otherDevices={otherDevices}
        query={query}
        filtered={filtered}
        viewMode={viewMode}
        isMobile={isMobile}
        clearFilters={clearFilters}
        page={page}
        pageSize={pageSize}
        onPage={setPage}
        onPageSize={setPageSize}
      />

      <FleetSelectionBar
        fleet={fleet}
        canOperate={canOperate}
        allowGroup={Boolean(onBulkAddToGroup)}
        onRunScript={() => setBulkScriptIds(selectedIds)}
        onGroup={() => setBulkGroupIds(selectedIds)}
      />

      {bulkScriptIds && bulkScriptIds.length > 0 ? (
        <BulkScriptModal agentIds={bulkScriptIds} onDismiss={() => setBulkScriptIds(null)} />
      ) : null}
      {bulkGroupIds && bulkGroupIds.length > 0 ? (
        <BulkAddToGroupModal agentIds={bulkGroupIds} onDismiss={() => setBulkGroupIds(null)} />
      ) : null}

      <FleetRemovalDialog fleet={fleet} />

      <AlertDialog
        open={powerConfirm !== null}
        onOpenChange={(open) => !open && setPowerConfirm(null)}
      >
        <AlertDialogContent>
          {powerConfirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {POWER_COPY[powerConfirm.action].title} {powerConfirm.row.displayName}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {POWER_COPY[powerConfirm.action].body}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    const { row, action } = powerConfirm;
                    setPowerConfirm(null);
                    if (action === "restart") onBatchRestart([row.id]);
                    else onBatchShutdown([row.id]);
                  }}
                >
                  {POWER_COPY[powerConfirm.action].cta}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FleetSelectionBar({
  fleet,
  canOperate,
  allowGroup,
  onRunScript,
  onGroup,
}: {
  fleet: ReturnType<typeof useFleetTable>;
  canOperate: boolean;
  allowGroup: boolean;
  onRunScript: () => void;
  onGroup: () => void;
}) {
  const { canDelete, selectedIds, filteredRows, deleting, setSelected, requestDelete } = fleet;
  return (
    <>
      {canDelete && selectedIds.length > 0 && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
          <div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-1 rounded-xl border border-border/70 bg-popover p-1.5 pl-3.5 text-sm animate-in fade-in-0 slide-in-from-bottom-2">
            <span className="mr-2 font-medium tabular-nums">{selectedIds.length} selected</span>
            {selectedIds.length < filteredRows.length && (
              <Button
                variant="ghost"
                size="sm"
                disabled={deleting}
                onClick={() => setSelected(new Set(filteredRows.map((row) => row.id)))}
              >
                Select all {filteredRows.length}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={() => setSelected(new Set())}
            >
              <X /> Clear
            </Button>
            {canOperate && (
              <Button variant="ghost" size="sm" disabled={deleting} onClick={onRunScript}>
                <SquareTerminal /> Run script
              </Button>
            )}
            {allowGroup && (
              <Button variant="ghost" size="sm" disabled={deleting} onClick={onGroup}>
                <FolderPlus /> Add to group
              </Button>
            )}
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={() => requestDelete(selectedIds)}
            >
              <Trash2 /> Remove devices ({selectedIds.length})
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function FleetRemovalDialog({ fleet }: { fleet: ReturnType<typeof useFleetTable> }) {
  const {
    deleteIds,
    deleting,
    setDeleteIds,
    removalIds,
    agents,
    rows,
    deleteError,
    confirmBulkDelete,
  } = fleet;
  return (
    <AlertDialog
      open={deleteIds !== null}
      onOpenChange={(open) => !open && !deleting && setDeleteIds(null)}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {removalIds.length} device
            {removalIds.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="grid gap-2">
            {(() => {
              const onlineCount = removalIds.filter((id) => agents[id]?.online).length;
              const names = removalIds
                .map((id) => rows.find((row) => row.id === id)?.displayName || id)
                .slice(0, 5);
              return (
                <>
                  <p>
                    This permanently removes{" "}
                    {removalIds.length === 1 ? "this agent" : `these ${removalIds.length} agents`}{" "}
                    from the server, including {removalIds.length === 1 ? "its" : "their"} telemetry
                    history.
                    {names.length > 0 && (
                      <>
                        {" "}
                        Affected:{" "}
                        <strong className="text-foreground break-all">{names.join(", ")}</strong>
                        {removalIds.length > names.length && (
                          <> and {removalIds.length - names.length} more</>
                        )}
                        .
                      </>
                    )}
                  </p>
                  {onlineCount > 0 && (
                    <p>
                      {onlineCount} of {removalIds.length === 1 ? "them is" : "them are"} currently
                      online and will be disconnected.
                    </p>
                  )}
                  <p>
                    Deleted agents stop reconnecting and show an error until they are re-enrolled.
                    This cannot be undone.
                  </p>
                </>
              );
            })()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{deleteError}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={() => void confirmBulkDelete()}
          >
            {deleting && <Spinner />} Remove devices
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function countFleetStatuses(rows: FleetRow[]): StatusCounts {
  const next: StatusCounts = {
    all: rows.length,
    online: 0,
    offline: 0,
    active: 0,
    afk: 0,
  };
  for (const row of rows) {
    if (row.online) next.online += 1;
    else next.offline += 1;
    if (row.status === "active") next.active += 1;
    if (row.status === "afk") next.afk += 1;
  }
  return next;
}

function createFleetActionHandlers({
  props,
  canOperate,
  canDelete,
  deleting,
  requestDelete,
  setPowerConfirm,
}: {
  props: Omit<Props, "loadingAgents" | "onAddAgent">;
  canOperate: boolean;
  canDelete: boolean;
  deleting: boolean;
  requestDelete: (ids: string[]) => void;
  setPowerConfirm: (confirmation: { row: FleetRow; action: "restart" | "shutdown" }) => void;
}): AgentActionHandlers {
  const { onSelectAgent, onOpenScreen, onBatchWake, onBatchLock } = props;
  return {
    onOpen: (row) => onSelectAgent(row.id),
    onLive: (row) => row.online && onOpenScreen(row.id),
    onActivity: (row) => row.online && onSelectAgent(row.id, "activity", true),
    onPower: (row, action) => {
      if (action === "wake") onBatchWake([row.id]);
      else if (action === "lock") onBatchLock([row.id]);
      else setPowerConfirm({ row, action });
    },
    onRemove: canDelete ? (row) => requestDelete([row.id]) : undefined,
    canOperate,
    removalBusy: deleting,
  };
}

function FleetRows({
  viewProps,
  otherDevices,
  query,
  filtered,
  viewMode,
  isMobile,
  clearFilters,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  viewProps: Omit<ComponentProps<typeof FleetGridView>, "extra">;
  otherDevices: DeviceRow[];
  query: string;
  filtered: boolean;
  viewMode: ReturnType<typeof useFleetTable>["viewMode"];
  isMobile: boolean;
  clearFilters: () => void;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  if (viewProps.rows.length === 0 && otherDevices.length === 0) {
    return (
      <EmptyState
        title="No devices match"
        description={
          query.trim() ? `Nothing matches “${query.trim()}”.` : "No device matches these filters."
        }
        icon={
          <>
            <SearchX />
          </>
        }
        iconVariant="icon"
        action={
          filtered && (
            <>
              <Button variant="outline" onClick={clearFilters}>
                <RotateCcw /> Clear filters
              </Button>
            </>
          )
        }
      />
    );
  }

  // Agent devices come first, then the devices that connect without one; the pager walks both.
  const combined = [
    ...viewProps.rows.map((row) => ({ agent: row })),
    ...otherDevices.map((row) => ({ other: row })),
  ];
  const paged = paginate(combined, page, pageSize);
  const pageRows = paged.items.flatMap((entry) => ("agent" in entry ? [entry.agent] : []));
  const pageOthers = paged.items.flatMap((entry) => ("other" in entry ? [entry.other] : []));
  const pager = (
    <TablePager
      total={combined.length}
      page={paged.page}
      pages={paged.pages}
      pageSize={pageSize}
      onPage={onPage}
      onPageSize={onPageSize}
    />
  );
  const otherCards = pageOthers.map((row) => <DeviceCard key={row.key} row={row} />);
  const pagerBar = (
    <div className="rounded-xl border border-border/70 bg-card/10 px-4 py-2.5">{pager}</div>
  );

  if (viewMode === "table" && !isMobile && pageRows.length > 0) {
    return (
      <div className="flex flex-col gap-4">
        <FleetTableView
          {...viewProps}
          rows={pageRows}
          footer={otherCards.length ? undefined : pager}
        />
        {otherCards.length > 0 && (
          <>
            <div className={FLEET_GRID_CLASS}>{otherCards}</div>
            {pagerBar}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <FleetGridView {...viewProps} rows={pageRows} extra={otherCards} />
      {pagerBar}
    </div>
  );
}
