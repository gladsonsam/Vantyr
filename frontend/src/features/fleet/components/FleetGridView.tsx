import { Activity, ArrowUpCircle, MonitorPlay } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Card } from "@vantyr/ui/components/card";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { cn } from "@/lib/utils";
import {
  formatLastSeen,
  formatUptime,
  hasValue,
  normalizeVersion,
  lastReportedTooltip,
} from "@/features/fleet/lib/fleetUtils";
import { AgentActionsMenu } from "./AgentActionsMenu";
import { ActivityCell } from "./ActivityCell";
import { FavoriteToggle } from "./FavoriteToggle";
import { PolicyBadges } from "./PolicyBadges";
import { DeviceIcon, OsMark } from "./FleetStatus";
import type { FleetViewProps } from "./FleetTableView";

export function FleetGridView({
  rows,
  favoriteIds,
  onToggleFavorite,
  selection,
  latestAgentVersion,
  handlers,
}: FleetViewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 min-[87.5rem]:grid-cols-3 min-[120rem]:grid-cols-4">
      {rows.map((row) => {
        const checked = Boolean(selection?.selected.has(row.id));
        const stored = row.online ? lastReportedTooltip(row.infoReportedAt) : undefined;
        return (
          <Card
            key={row.id}
            onClick={() => handlers.onOpen(row)}
            data-selected={checked || undefined}
            className="cursor-pointer gap-0 rounded-lg border border-border/70 bg-[color-mix(in_oklch,var(--ui-card),white_5%)] py-0 shadow-none ring-0 transition-colors hover:border-foreground/20 data-selected:border-primary/70"
          >
            <div className="flex items-center gap-3 px-4 pt-3.5 pb-3 sm:px-5 sm:pt-4">
              <DeviceIcon row={row} showStatus />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "truncate text-[15px] font-semibold",
                      !row.online && "text-muted-foreground",
                    )}
                  >
                    {row.displayName}
                  </span>
                  <OsMark row={row} />
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {hasValue(row.user) ? row.user : "No user"}
                </div>
              </div>
              <div className="-mr-2 flex items-center" onClick={(event) => event.stopPropagation()}>
                <FavoriteToggle
                  name={row.displayName}
                  favorite={favoriteIds.has(row.id)}
                  disabled={!onToggleFavorite}
                  onToggle={() => onToggleFavorite?.(row.id)}
                />
                {selection && (
                  <label className="hidden size-7 cursor-pointer items-center justify-center sm:flex">
                    <Checkbox
                      aria-label={`Select ${row.displayName}`}
                      checked={checked}
                      disabled={selection.disabled}
                      onCheckedChange={() => selection.toggle(row.id)}
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="border-t border-border/60 bg-black/10 px-4 py-2.5 sm:px-5">
              <ActivityCell row={row} />
            </div>

            <p className="hidden flex-wrap items-center gap-x-2 gap-y-0.5 bg-black/10 px-5 pt-0.5 pb-3 text-xs text-muted-foreground tabular-nums sm:flex">
              <span title={stored}>
                {row.online
                  ? `Up ${formatUptime(row.effectiveUptimeSecs)}`
                  : `Seen ${formatLastSeen(row.last_seen)}`}
              </span>
              {hasValue(row.ip) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans text-foreground/80" title="IP address">
                    {row.ip}
                  </span>
                </>
              )}
              {row.version && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 font-sans whitespace-nowrap",
                      row.updateNeeded ? "text-warning" : "text-foreground/80",
                    )}
                    title={
                      row.updateNeeded
                        ? `Update to v${normalizeVersion(latestAgentVersion)} available`
                        : "Agent version"
                    }
                  >
                    v{normalizeVersion(row.version)}
                    {row.updateNeeded && (
                      <ArrowUpCircle className="size-3.5" aria-label="Update available" />
                    )}
                  </span>
                </>
              )}
            </p>

            <div className="bg-black/10 px-5 pb-3 empty:hidden">
              <PolicyBadges row={row} />
            </div>

            <div
              className="mt-auto flex items-center gap-1 border-t border-border/60 bg-black/20 px-2 py-1.5 sm:px-3 sm:py-2"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                variant="ghost"
                className="flex-1 font-medium text-foreground"
                disabled={!row.online}
                onClick={() => handlers.onLive(row)}
              >
                <MonitorPlay /> Live
              </Button>
              <Button
                variant="ghost"
                className="flex-1 text-muted-foreground hover:text-foreground"
                onClick={() => handlers.onActivity(row)}
              >
                <Activity /> Activity
              </Button>
              <AgentActionsMenu row={row} handlers={handlers} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
