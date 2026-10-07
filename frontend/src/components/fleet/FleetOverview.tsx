import { useMemo, useState } from "react";
import { FolderPlus, Plus, SearchX, ServerOff, SquareTerminal, Trash2, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { FleetStatusFilter } from "@/lib/fleetPreferences";
import type { TabKey } from "@/lib/agentTabNav";
import type { FleetRow } from "@/components/overview/types";
import { useFleetTable, type FleetTableProps } from "@/components/overview/useFleetTable";
import type { AgentActionHandlers, PowerAction } from "./AgentActionsMenu";
import { FleetGridView } from "./FleetGridView";
import { FleetTableView } from "./FleetTableView";
import { FleetToolbar, type StatusCounts } from "./FleetToolbar";
import { BulkScriptModal } from "@/components/overview/BulkScriptModal";
import { BulkAddToGroupModal } from "@/components/overview/BulkAddToGroupModal";

interface Props extends FleetTableProps {
  loadingAgents: boolean;
  onSelectAgent: (agentId: string, tab?: TabKey, scroll?: boolean) => void;
  onAddAgent?: () => void;
}

const POWER_COPY: Record<Exclude<PowerAction, "lock" | "wake">, { title: string; body: string; cta: string }> = {
  restart: { title: "Restart", body: "Anyone using the device will be signed out and unsaved work may be lost.", cta: "Restart device" },
  shutdown: { title: "Shut down", body: "The device powers off. Bring it back with Wake on LAN if it is configured and reachable.", cta: "Shut down device" },
};

function FleetSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 min-[87.5rem]:grid-cols-3 min-[120rem]:grid-cols-4">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-72 rounded-xl" />
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
        <Skeleton className="h-8 w-full max-w-xl" />
        <FleetSkeleton />
      </div>
    );
  }
  if (Object.keys(props.agents).length === 0) {
    return (
      <Empty className="bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerOff />
          </EmptyMedia>
          <EmptyTitle>No agents enrolled yet</EmptyTitle>
          <EmptyDescription>Install the Vantyr agent on a device and approve it here to start monitoring.</EmptyDescription>
        </EmptyHeader>
        {onAddAgent && (
          <EmptyContent>
            <Button onClick={onAddAgent}>
              <Plus /> Enroll agent
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  }
  return <FleetContent {...props} />;
}

function FleetContent(props: Omit<Props, "loadingAgents" | "onAddAgent">) {
  const { onSelectAgent, onOpenScreen, onBatchWake, onBatchLock, onBatchRestart, onBatchShutdown, canOperate = true, onBulkAddToGroup } = props;
  const fleet = useFleetTable(props);
  const {
    rows, filteredRows, query, currentFilters, viewMode, fleetSort, preferences, preferenceScope, favoriteIds, toggleFavorite,
    changeQuery, changeFilters, changeView, setFleetSort, applyView, updatePreferences, onQueryChange, isMobile, versionPayload,
    canDelete, selected, selectedIds, setSelected, toggleSelect, deleting, deleteError, deleteIds, setDeleteIds, requestDelete,
    confirmBulkDelete, removalIds, agents,
  } = fleet;
  const [powerConfirm, setPowerConfirm] = useState<{ row: FleetRow; action: "restart" | "shutdown" } | null>(null);
  const [bulkScriptIds, setBulkScriptIds] = useState<string[] | null>(null);
  const [bulkGroupIds, setBulkGroupIds] = useState<string[] | null>(null);

  const counts = useMemo<StatusCounts>(() => {
    const next: StatusCounts = { all: rows.length, online: 0, offline: 0, active: 0, afk: 0 };
    for (const row of rows) {
      if (row.online) next.online += 1;
      else next.offline += 1;
      if (row.status === "active") next.active += 1;
      if (row.status === "afk") next.afk += 1;
    }
    return next;
  }, [rows]);

  const setStatus = (status: FleetStatusFilter) => changeFilters({ status });
  const clearFilters = () => {
    changeFilters({ search: "", status: "all", favoritesOnly: false });
    onQueryChange?.("");
  };

  const handlers: AgentActionHandlers = {
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

  const viewProps = {
    rows: filteredRows,
    favoriteIds,
    onToggleFavorite: preferenceScope ? toggleFavorite : undefined,
    latestAgentVersion: versionPayload?.latest_agent_version,
    handlers,
    selection: canDelete
      ? { selected, toggle: toggleSelect, setAll: (ids: string[]) => setSelected(new Set(ids)), disabled: deleting }
      : undefined,
  };

  const filtered = Boolean(query.trim() || currentFilters.status !== "all" || currentFilters.favoritesOnly);

  return (
    <div className="flex flex-col gap-6">
      <FleetToolbar
        key={preferenceScope ?? "unverified"}
        current={{ search: query, status: currentFilters.status, view: viewMode, sort: fleetSort, favoritesOnly: currentFilters.favoritesOnly }}
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
              { name, search: query, status: currentFilters.status, view: viewMode, sort: fleetSort, favoritesOnly: currentFilters.favoritesOnly },
            ],
          }))
        }
        onRemove={(name) => updatePreferences((previous) => ({ ...previous, views: previous.views.filter((view) => view.name !== name) }))}
        onClear={clearFilters}
      />

      {filteredRows.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>No devices match</EmptyTitle>
            <EmptyDescription>
              {rows.length} device{rows.length === 1 ? " is" : "s are"} hidden by the current filters.
            </EmptyDescription>
          </EmptyHeader>
          {filtered && (
            <EmptyContent>
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : viewMode === "table" && !isMobile ? (
        <FleetTableView {...viewProps} />
      ) : (
        <FleetGridView {...viewProps} />
      )}

      {canDelete && selectedIds.length > 0 && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
          <div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-1 rounded-xl bg-popover p-1.5 pl-3.5 text-sm shadow-2xl shadow-black/50 ring-1 ring-foreground/10 animate-in fade-in-0 slide-in-from-bottom-2">
            <span className="mr-2 font-medium tabular-nums">{selectedIds.length} selected</span>
            {selectedIds.length < filteredRows.length && (
              <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setSelected(new Set(filteredRows.map((row) => row.id)))}>
                Select all {filteredRows.length}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setSelected(new Set())}>
              <X /> Clear
            </Button>
            {canOperate && (
              <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setBulkScriptIds(selectedIds)}>
                <SquareTerminal /> Run script
              </Button>
            )}
            {onBulkAddToGroup && (
              <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setBulkGroupIds(selectedIds)}>
                <FolderPlus /> Add to group
              </Button>
            )}
            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => requestDelete(selectedIds)}>
              <Trash2 /> Remove devices ({selectedIds.length})
            </Button>
          </div>
        </div>
      )}

      {bulkScriptIds && bulkScriptIds.length > 0 ? (
        <BulkScriptModal agentIds={bulkScriptIds} onDismiss={() => setBulkScriptIds(null)} />
      ) : null}
      {bulkGroupIds && bulkGroupIds.length > 0 ? (
        <BulkAddToGroupModal agentIds={bulkGroupIds} onDismiss={() => setBulkGroupIds(null)} />
      ) : null}

      <AlertDialog open={deleteIds !== null} onOpenChange={(open) => !open && !deleting && setDeleteIds(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removalIds.length} device{removalIds.length === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="grid gap-2">
              {(() => {
                const onlineCount = removalIds.filter((id) => agents[id]?.online).length;
                const names = removalIds.map((id) => rows.find((row) => row.id === id)?.displayName || id).slice(0, 5);
                return (
                  <>
                    <p>
                      This permanently removes {removalIds.length === 1 ? "this agent" : `these ${removalIds.length} agents`} from the server,
                      including {removalIds.length === 1 ? "its" : "their"} telemetry history.
                      {names.length > 0 && (
                        <>
                          {" "}Affected: <strong className="text-foreground break-all">{names.join(", ")}</strong>
                          {removalIds.length > names.length && <> and {removalIds.length - names.length} more</>}.
                        </>
                      )}
                    </p>
                    {onlineCount > 0 && (
                      <p>
                        {onlineCount} of {removalIds.length === 1 ? "them is" : "them are"} currently online and will be disconnected.
                      </p>
                    )}
                    <p>Deleted agents stop reconnecting and show an error until they are re-enrolled. This cannot be undone.</p>
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
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void confirmBulkDelete()}>
              {deleting && <Spinner />} Remove devices
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={powerConfirm !== null} onOpenChange={(open) => !open && setPowerConfirm(null)}>
        <AlertDialogContent>
          {powerConfirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {POWER_COPY[powerConfirm.action].title} {powerConfirm.row.displayName}?
                </AlertDialogTitle>
                <AlertDialogDescription>{POWER_COPY[powerConfirm.action].body}</AlertDialogDescription>
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
