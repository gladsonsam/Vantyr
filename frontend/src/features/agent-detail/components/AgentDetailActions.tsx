import { Power, RotateCw, Shield } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
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

/** Lock / restart / shutdown / wake buttons on the right of the agent header. */
export function AgentDetailActions({
  agent,
  isViewer,
  systemControlAvailable,
  pendingAction,
  onAction,
}: AgentDetailActionsProps) {
  return (
    <div className="order-2 ml-auto flex shrink-0 items-center gap-2 sm:order-3 sm:ml-0">
      {!isViewer && (
        <>
          <Button
            variant="ghost"
            size="lg"
            disabled={!agent.online || !systemControlAvailable}
            onClick={() => onAction("lock-host")}
          >
            <Shield />
            <span className="hidden sm:inline">Lock</span>
          </Button>
          <Button
            variant="ghost"
            size="lg"
            disabled={!agent.online || !systemControlAvailable}
            onClick={() => onAction("restart-host")}
          >
            <RotateCw />
            <span className="hidden sm:inline">Restart</span>
          </Button>
          <Button
            variant="destructive"
            size="lg"
            disabled={!agent.online || !systemControlAvailable}
            onClick={() => onAction("shutdown-host")}
          >
            <Power />
            <span className="hidden sm:inline">Shutdown</span>
          </Button>
        </>
      )}
      {!agent.online && !isViewer && (
        <Button
          size="lg"
          disabled={pendingAction === "wake-lan"}
          onClick={() => onAction("wake-lan")}
        >
          {pendingAction === "wake-lan" && <Spinner />}
          <Power />
          <span className="hidden sm:inline">Wake</span>
        </Button>
      )}
    </div>
  );
}
