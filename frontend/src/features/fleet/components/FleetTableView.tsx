import type { ReactNode } from "react";
import { ArrowUpCircle, MonitorPlay } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vantyr/ui/components/tooltip";
import { SortHeaderButton } from "@/components/common/data-table/SortHeaderButton";
import { cn } from "@/lib/utils";
import {
  formatLastSeen,
  formatUptime,
  hasValue,
  normalizeVersion,
  lastReportedTooltip,
} from "@/features/fleet/lib/fleetUtils";
import type { FleetSort } from "@/features/fleet/lib/fleetSort";
import type { FleetRow } from "@/features/fleet/types";
import { DEFAULT_FLEET_COLUMNS, type FleetColumnId } from "@/features/fleet/lib/fleetColumns";
import { AgentActionsMenu, type AgentActionHandlers } from "./AgentActionsMenu";
import { ActivityCell } from "./ActivityCell";
import { FavoriteToggle } from "./FavoriteToggle";
import { PolicyBadges } from "./PolicyBadges";
import { DeviceIcon, OsMark, StatusDot, StatusText } from "./FleetStatus";

export interface FleetViewProps {
  rows: FleetRow[];
  favoriteIds: ReadonlySet<string>;
  onToggleFavorite?: (id: string) => void;
  selection?: {
    selected: ReadonlySet<string>;
    toggle: (id: string) => void;
    setAll: (ids: string[]) => void;
    disabled?: boolean;
  };
  latestAgentVersion?: string | null;
  handlers: AgentActionHandlers;
  /** Active sort and its setter; the list headers sort when both are given. */
  sort?: FleetSort;
  onSort?: (sort: FleetSort) => void;
  /** Visible optional columns of the list view. */
  columns?: ReadonlySet<FleetColumnId>;
  /** Footer row of the list card (pagination). */
  footer?: ReactNode;
}

const ACTIONS_CELL = "w-28 pr-5!";

function SortHead({
  title,
  sortKey,
  sort,
  onSort,
}: {
  title: string;
  sortKey: FleetSort["key"];
  sort?: FleetSort;
  onSort?: (sort: FleetSort) => void;
}) {
  if (!sort || !onSort) return <>{title}</>;
  const active = sort.key === sortKey;
  return (
    <SortHeaderButton
      title={title}
      direction={active ? sort.direction : null}
      onClick={() =>
        onSort({
          key: sortKey,
          direction: active && sort.direction === "asc" ? "desc" : "asc",
        })
      }
    />
  );
}

export function FleetTableView({
  rows,
  favoriteIds,
  onToggleFavorite,
  selection,
  latestAgentVersion,
  handlers,
  sort,
  onSort,
  columns = DEFAULT_FLEET_COLUMNS,
  footer,
}: FleetViewProps) {
  const selectedVisible = selection
    ? rows.filter((row) => selection.selected.has(row.id)).length
    : 0;
  const allSelected = rows.length > 0 && selectedVisible === rows.length;
  const show = (id: FleetColumnId) => columns.has(id);
  return (
    <div className="@container overflow-hidden rounded-xl border border-border/70 bg-card/10">
      <Table>
        <TableHeader className="[&_tr]:border-border/40 [&_th]:h-10 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
          <TableRow className="bg-muted/20 hover:bg-muted/20">
            {selection && (
              <TableHead className="w-12 pl-5!">
                <Checkbox
                  aria-label="Select all visible devices"
                  checked={allSelected}
                  indeterminate={selectedVisible > 0 && !allSelected}
                  disabled={selection.disabled || rows.length === 0}
                  onCheckedChange={(checked) =>
                    selection.setAll(checked ? rows.map((row) => row.id) : [])
                  }
                />
              </TableHead>
            )}
            <TableHead className={cn("min-w-48", !selection && "pl-5!")}>
              <SortHead title="Device" sortKey="name" sort={sort} onSort={onSort} />
            </TableHead>
            <TableHead className="w-36">
              <SortHead title="Status" sortKey="connectivity" sort={sort} onSort={onSort} />
            </TableHead>
            {show("activity") && <TableHead className="min-w-44">Current activity</TableHead>}
            {show("uptime") && <TableHead className="hidden w-32 @2xl:table-cell">Uptime</TableHead>}
            {show("lastSeen") && (
              <TableHead className="hidden w-32 @2xl:table-cell">
                <SortHead title="Last seen" sortKey="last_seen" sort={sort} onSort={onSort} />
              </TableHead>
            )}
            {show("version") && (
              <TableHead className="hidden w-28 @4xl:table-cell">
                <SortHead title="Version" sortKey="agent_version" sort={sort} onSort={onSort} />
              </TableHead>
            )}
            <TableHead className={cn(ACTIONS_CELL, "text-right")}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
          {rows.map((row) => {
            const checked = Boolean(selection?.selected.has(row.id));
            const stored = row.online ? lastReportedTooltip(row.infoReportedAt) : undefined;
            return (
              <TableRow
                key={row.id}
                data-state={checked ? "selected" : undefined}
                onClick={() => handlers.onOpen(row)}
                className="group cursor-pointer border-border/40 hover:bg-muted/40 data-[state=selected]:bg-muted/40"
              >
                {selection && (
                  <TableCell className="pl-5!" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select ${row.displayName}`}
                      checked={checked}
                      disabled={selection.disabled}
                      onCheckedChange={() => selection.toggle(row.id)}
                    />
                  </TableCell>
                )}
                <TableCell className={cn(!selection && "pl-5!")}>
                  <div className="flex min-w-0 items-center gap-3.5">
                    <DeviceIcon row={row} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate font-medium",
                            !row.online && "text-muted-foreground",
                          )}
                        >
                          {row.displayName}
                        </span>
                        <OsMark row={row} />
                      </div>
                      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate">
                          {hasValue(row.user) ? row.user : "No user"}
                        </span>
                        <span aria-hidden="true">·</span>
                        {hasValue(row.ip) ? (
                          <span className="truncate font-sans">{row.ip}</span>
                        ) : (
                          <span className="truncate">No IP reported</span>
                        )}
                        {row.updateNeeded && show("version") && (
                          <ArrowUpCircle
                            className="size-3.5 shrink-0 text-warning @4xl:hidden"
                            aria-label="Update available"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1.5">
                    <span className="inline-flex items-center gap-2">
                      <StatusDot row={row} />
                      <StatusText row={row} className="text-[13px]" />
                    </span>
                    <PolicyBadges row={row} />
                  </div>
                </TableCell>
                {show("activity") && (
                  <TableCell className="max-w-80">
                    <ActivityCell row={row} />
                  </TableCell>
                )}
                {show("uptime") && (
                  <TableCell className="hidden text-xs tabular-nums @2xl:table-cell" title={stored}>
                    {row.online ? (
                      formatUptime(row.effectiveUptimeSecs)
                    ) : (
                      <span className="text-muted-foreground">
                        seen {formatLastSeen(row.last_seen)}
                      </span>
                    )}
                  </TableCell>
                )}
                {show("lastSeen") && (
                  <TableCell
                    className="hidden text-xs text-muted-foreground tabular-nums @2xl:table-cell"
                    title={stored}
                  >
                    {formatLastSeen(row.last_seen)}
                  </TableCell>
                )}
                {show("version") && (
                  <TableCell className="hidden @4xl:table-cell">
                    <div className="flex items-center gap-1.5">
                      {row.version ? (
                        <span className="font-mono text-xs">v{normalizeVersion(row.version)}</span>
                      ) : (
                        <span className="font-sans text-xs text-muted-foreground">Unknown</span>
                      )}
                      {row.updateNeeded && (
                        <Tooltip>
                          <TooltipTrigger render={<span className="inline-flex text-warning" />}>
                            <ArrowUpCircle className="size-3.5" aria-label="Update available" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Update to v{normalizeVersion(latestAgentVersion)} available
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>
                )}
                <TableCell className={ACTIONS_CELL} onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center justify-end gap-0.5">
                    <FavoriteToggle
                      name={row.displayName}
                      favorite={favoriteIds.has(row.id)}
                      disabled={!onToggleFavorite}
                      onToggle={() => onToggleFavorite?.(row.id)}
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Live screen for ${row.displayName}`}
                            disabled={!row.online}
                            onClick={() => handlers.onLive(row)}
                          />
                        }
                      >
                        <MonitorPlay />
                      </TooltipTrigger>
                      <TooltipContent>Live screen</TooltipContent>
                    </Tooltip>
                    <AgentActionsMenu row={row} handlers={handlers} />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {footer ? <div className="border-t border-border/40 px-4 py-2.5">{footer}</div> : null}
    </div>
  );
}
