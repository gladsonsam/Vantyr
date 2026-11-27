import type { ReactNode } from "react";
import { Activity, ArrowUpCircle, MonitorPlay } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  ResourceCard,
  ResourceCardField,
  ResourceCardFields,
} from "@/components/common/data-table/ResourceCard";
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
import { DeviceIcon, OsMark, StatusDot, StatusText } from "./FleetStatus";
import type { FleetViewProps } from "./FleetTableView";

export const FLEET_GRID_CLASS =
  "grid grid-cols-1 gap-4 md:grid-cols-2 min-[87.5rem]:grid-cols-3 min-[120rem]:grid-cols-4";

/** Devices as Arcane resource cards: icon tile, title, labelled meta list and footer actions. */
export function FleetGridView({
  rows,
  favoriteIds,
  onToggleFavorite,
  selection,
  latestAgentVersion,
  handlers,
  extra,
}: FleetViewProps & {
  /** Further device cards that share this grid, such as devices that connect without an agent. */
  extra?: ReactNode;
}) {
  return (
    <div className={FLEET_GRID_CLASS}>
      {rows.map((row) => {
        const checked = Boolean(selection?.selected.has(row.id));
        const stored = row.online ? lastReportedTooltip(row.infoReportedAt) : undefined;
        return (
          <ResourceCard
            key={row.id}
            selected={checked}
            onClick={() => handlers.onOpen(row)}
            select={
              selection ? (
                <Checkbox
                  aria-label={`Select ${row.displayName}`}
                  checked={checked}
                  disabled={selection.disabled}
                  onCheckedChange={() => selection.toggle(row.id)}
                />
              ) : undefined
            }
            icon={<DeviceIcon row={row} showStatus />}
            title={
              <>
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
              </>
            }
            actions={
              <FavoriteToggle
                name={row.displayName}
                favorite={favoriteIds.has(row.id)}
                disabled={!onToggleFavorite}
                onToggle={() => onToggleFavorite?.(row.id)}
              />
            }
            context={
              <>
                <StatusDot row={row} />
                <StatusText row={row} />
              </>
            }
            fields={
              <ResourceCardFields>
                <ResourceCardField label="Activity" wide>
                  <ActivityCell row={row} />
                </ResourceCardField>
                <ResourceCardField label={row.online ? "Uptime" : "Last seen"} title={stored}>
                  <span className="tabular-nums">
                    {row.online
                      ? formatUptime(row.effectiveUptimeSecs)
                      : formatLastSeen(row.last_seen)}
                  </span>
                </ResourceCardField>
                <ResourceCardField label="IP address">
                  {hasValue(row.ip) ? (
                    <span title="IP address">{row.ip}</span>
                  ) : (
                    <span className="text-muted-foreground">Not reported</span>
                  )}
                </ResourceCardField>
                {row.version && (
                  <ResourceCardField
                    label="Agent"
                    title={
                      row.updateNeeded
                        ? `Update to v${normalizeVersion(latestAgentVersion)} available`
                        : "Agent version"
                    }
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 font-mono text-xs",
                        row.updateNeeded && "text-warning",
                      )}
                    >
                      v{normalizeVersion(row.version)}
                      {row.updateNeeded && (
                        <ArrowUpCircle className="size-3.5" aria-label="Update available" />
                      )}
                    </span>
                  </ResourceCardField>
                )}
              </ResourceCardFields>
            }
            footer={
              <div className="-mx-2 flex w-full items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 font-medium text-foreground"
                  disabled={!row.online}
                  onClick={() => handlers.onLive(row)}
                >
                  <MonitorPlay /> Live
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 text-muted-foreground hover:text-foreground"
                  onClick={() => handlers.onActivity(row)}
                >
                  <Activity /> Activity
                </Button>
                <AgentActionsMenu row={row} handlers={handlers} />
              </div>
            }
          >
            <div className="py-2 empty:hidden">
              <PolicyBadges row={row} />
            </div>
          </ResourceCard>
        );
      })}
      {extra}
    </div>
  );
}
