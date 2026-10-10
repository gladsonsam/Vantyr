import { ArrowUpCircle, MonitorPlay } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vantyr/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vantyr/ui/components/tooltip";
import { cn } from "@/lib/utils";
import { formatLastSeen, formatUptime, hasValue, normalizeVersion, storedUptimeNote } from "@/features/fleet/lib/fleetUtils";
import type { FleetRow } from "@/features/fleet/types";
import { AgentActionsMenu, type AgentActionHandlers } from "./AgentActionsMenu";
import { ActivityCell } from "./ActivityCell";
import { FavoriteToggle } from "./FavoriteToggle";
import { PolicyBadges } from "./PolicyBadges";
import { DeviceIcon, OsMark, StatusText } from "./FleetStatus";

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
}

const ACTIONS_CELL =
  "sticky right-0 z-10 w-28 bg-card pr-5! shadow-[-12px_0_12px_-12px_rgb(0_0_0/0.5)] group-hover:bg-[color-mix(in_oklch,var(--ui-card),white_5%)] group-data-[state=selected]:bg-[color-mix(in_oklch,var(--ui-card),white_8%)]";

export function FleetTableView({ rows, favoriteIds, onToggleFavorite, selection, latestAgentVersion, handlers }: FleetViewProps) {
  const selectedVisible = selection ? rows.filter((row) => selection.selected.has(row.id)).length : 0;
  const allSelected = rows.length > 0 && selectedVisible === rows.length;
  return (
    <div className="@container overflow-hidden rounded-xl bg-card">
      <Table>
        <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
          <TableRow className="hover:bg-transparent">
            {selection && (
              <TableHead className="w-12 pl-5!">
                <Checkbox
                  aria-label="Select all visible devices"
                  checked={allSelected}
                  indeterminate={selectedVisible > 0 && !allSelected}
                  disabled={selection.disabled || rows.length === 0}
                  onCheckedChange={(checked) => selection.setAll(checked ? rows.map((row) => row.id) : [])}
                />
              </TableHead>
            )}
            <TableHead className={cn("min-w-48", !selection && "pl-5!")}>Device</TableHead>
            <TableHead className="w-32">Status</TableHead>
            <TableHead className="min-w-44">Current activity</TableHead>
            <TableHead className="hidden w-32 @2xl:table-cell">Uptime</TableHead>
            <TableHead className="hidden w-28 @4xl:table-cell">Version</TableHead>
            <TableHead className={cn(ACTIONS_CELL, "text-right")}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
          {rows.map((row) => {
            const checked = Boolean(selection?.selected.has(row.id));
            const stored = row.online ? storedUptimeNote(row.infoReportedAt) : undefined;
            return (
              <TableRow
                key={row.id}
                data-state={checked ? "selected" : undefined}
                onClick={() => handlers.onOpen(row)}
                className="group cursor-pointer"
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
                        <span className={cn("truncate font-medium", !row.online && "text-muted-foreground")}>{row.displayName}</span>
                        <OsMark row={row} />
                      </div>
                      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate">{hasValue(row.user) ? row.user : "No user"}</span>
                        <span aria-hidden="true">·</span>
                        {hasValue(row.ip) ? <span className="truncate font-mono">{row.ip}</span> : <span className="truncate">No IP reported</span>}
                        {row.updateNeeded && (
                          <ArrowUpCircle className="size-3.5 shrink-0 text-warning @4xl:hidden" aria-label="Update available" />
                        )}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1.5">
                    <StatusText row={row} className="text-[13px]" />
                    <PolicyBadges row={row} />
                  </div>
                </TableCell>
                <TableCell className="max-w-80">
                  <ActivityCell row={row} />
                </TableCell>
                <TableCell className="hidden text-xs tabular-nums @2xl:table-cell" title={stored?.tooltip}>
                  {row.online ? (
                    <>
                      <div>{formatUptime(row.effectiveUptimeSecs)}</div>
                      {stored && <div className="mt-0.5 text-[11px] text-muted-foreground">{stored.hint}</div>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">seen {formatLastSeen(row.last_seen)}</span>
                  )}
                </TableCell>
                <TableCell className="hidden font-mono text-xs tabular-nums @4xl:table-cell">
                  <div className="flex items-center gap-1.5">
                    {row.version ? `v${normalizeVersion(row.version)}` : <span className="font-sans text-muted-foreground">Unknown</span>}
                    {row.updateNeeded && (
                      <Tooltip>
                        <TooltipTrigger render={<span className="inline-flex text-warning" />}>
                          <ArrowUpCircle className="size-3.5" aria-label="Update available" />
                        </TooltipTrigger>
                        <TooltipContent>Update to v{normalizeVersion(latestAgentVersion)} available</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </TableCell>
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
                            className="hover:bg-primary hover:text-primary-foreground"
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
    </div>
  );
}
