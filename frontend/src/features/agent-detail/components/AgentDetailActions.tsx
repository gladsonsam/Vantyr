import { ChevronDown, Lock, Power, RotateCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { Agent } from "@/api/types";
import type { AgentAction } from "@/features/agent-detail/lib/agentStatus";

interface AgentDetailActionsProps {
  agent: Agent;
  isViewer: boolean;
  systemControlAvailable: boolean;
  pendingAction: AgentAction | null;
  onAction: (action: AgentAction) => void;
}

/**
 * Power actions on the right of the agent header: one "Power" menu while the device is online
 * (restart and shut down still confirm), a Wake button while it is offline.
 */
export function AgentDetailActions({
  agent,
  isViewer,
  systemControlAvailable,
  pendingAction,
  onAction,
}: AgentDetailActionsProps) {
  if (isViewer) return null;
  const powerPending = pendingAction === "lock-host" || pendingAction === "restart-host" || pendingAction === "shutdown-host";
  return (
    <div className="order-2 ml-auto flex shrink-0 items-center gap-2 sm:order-3 sm:ml-0">
      {agent.online ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" disabled={!systemControlAvailable} aria-label="Power actions" />}
          >
            {powerPending ? <Spinner /> : <Power />}
            Power
            <ChevronDown className="opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => onAction("lock-host")}>
              <Lock /> Lock screen
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction("restart-host")}>
              <RotateCw /> Restart…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onAction("shutdown-host")}>
              <Power /> Shut down…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button variant="outline" disabled={pendingAction === "wake-lan"} onClick={() => onAction("wake-lan")}>
          {pendingAction === "wake-lan" ? <Spinner /> : <Power />}
          Wake
        </Button>
      )}
    </div>
  );
}
