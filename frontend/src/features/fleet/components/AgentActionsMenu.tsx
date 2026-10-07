import { Activity, Lock, MonitorPlay, MoreHorizontal, Power, RotateCcw, SquareArrowOutUpRight, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FleetRow } from "@/features/fleet/types";

export type PowerAction = "wake" | "lock" | "restart" | "shutdown";

export interface AgentActionHandlers {
  onOpen: (row: FleetRow) => void;
  onLive: (row: FleetRow) => void;
  onActivity: (row: FleetRow) => void;
  onPower: (row: FleetRow, action: PowerAction) => void;
  onRemove?: (row: FleetRow) => void;
  canOperate: boolean;
  removalBusy?: boolean;
}

export function AgentActionsMenu({ row, handlers }: { row: FleetRow; handlers: AgentActionHandlers }) {
  const { onOpen, onLive, onActivity, onPower, onRemove, canOperate, removalBusy } = handlers;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${row.displayName}`} />}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{row.displayName}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onOpen(row)}>
            <SquareArrowOutUpRight /> Open device
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!row.online} onClick={() => onLive(row)}>
            <MonitorPlay /> Live screen
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!row.online} onClick={() => onActivity(row)}>
            <Activity /> Activity timeline
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{canOperate ? "Power" : "Power · view only"}</DropdownMenuLabel>
          {row.online ? (
            <>
              <DropdownMenuItem disabled={!canOperate} onClick={() => onPower(row, "lock")}>
                <Lock /> Lock screen
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canOperate} onClick={() => onPower(row, "restart")}>
                <RotateCcw /> Restart…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canOperate} variant="destructive" onClick={() => onPower(row, "shutdown")}>
                <Power /> Shut down…
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem disabled={!canOperate} onClick={() => onPower(row, "wake")}>
              <Zap /> Wake on LAN
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {onRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={removalBusy} onClick={() => onRemove(row)}>
              <Trash2 /> Remove device…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
