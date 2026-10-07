import { ArrowUpCircle, MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatLastSeen, formatUptime, normalizeVersion } from "@/features/fleet/lib/fleetUtils";
import type { FleetRow } from "@/features/fleet/types";
import { AgentActionsMenu, type AgentActionHandlers } from "./AgentActionsMenu";
import { ActivityCell } from "./ActivityCell";
import { FavoriteToggle } from "./FavoriteToggle";
import { PolicyBadges } from "./PolicyBadges";
import { DeviceIcon, OsMark, StatusText } from "./status";

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

export function FleetTableView({ rows, favoriteIds, onToggleFavorite, selection, latestAgentVersion, handlers }: FleetViewProps) {
  const selectedVisible = selection ? rows.filter((row) => selection.selected.has(row.id)).length : 0;
  const allSelected = rows.length > 0 && selectedVisible === rows.length;
  return (
    <div className="overflow-hidden rounded-xl bg-card">
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
            <TableHead className={cn("min-w-64", !selection && "pl-5!")}>Device</TableHead>
            <TableHead className="w-36">Status</TableHead>
            <TableHead className="min-w-56">Current activity</TableHead>
            <TableHead className="w-32">Uptime</TableHead>
            <TableHead className="w-32">Version</TableHead>
            <TableHead className="w-28 pr-5! text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
          {rows.map((row) => {
            const checked = Boolean(selection?.selected.has(row.id));
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
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {row.user} · {row.ip}
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
                <TableCell
                  title={row.online && row.infoReportedAt ? `Stored snapshot received ${row.infoReportedAt}; freshness is unknown` : undefined}
                  className="font-mono text-xs tabular-nums"
                >
                  {row.online ? (
                    formatUptime(row.effectiveUptimeSecs)
                  ) : (
                    <span className="text-muted-foreground">seen {formatLastSeen(row.last_seen)}</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">
                  <div className="flex items-center gap-1.5">
                    {row.version ? `v${normalizeVersion(row.version)}` : "-"}
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
                <TableCell className="pr-5!" onClick={(event) => event.stopPropagation()}>
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
