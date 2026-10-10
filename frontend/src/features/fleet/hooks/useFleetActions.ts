import { useCallback, useMemo } from "react";
import { useAgents } from "@/app/providers/useAgents";
import { useNotifications } from "@/app/providers/useNotifications";
import { useSession } from "@/app/providers/useSession";
import { api } from "@/api";

export type FleetControlCommand = "RestartHost" | "ShutdownHost" | "LockHost";

/** Batch Wake-on-LAN and power/lock commands for a selection of agents, with result notices. */
export function useFleetActions() {
  const { user } = useSession();
  const { agents, send } = useAgents();
  const { info, warning, error } = useNotifications();
  const isViewer = user?.role === "viewer";

  const wake = useCallback(
    async (agentIds: string[]) => {
      if (isViewer) {
        error("Not permitted", "Viewers cannot wake agents. Ask an operator or administrator.");
        return;
      }
      if (agentIds.length === 0) return;
      const results = await Promise.allSettled(agentIds.map((id) => api.wakeAgent(id)));
      let ok = 0;
      const errors: string[] = [];
      results.forEach((r, i) => {
        const name = agents[agentIds[i]]?.name ?? agentIds[i];
        if (r.status === "fulfilled") ok += 1;
        else errors.push(`${name}: ${r.reason}`);
      });
      const fail = results.length - ok;
      if (fail === 0) {
        info(
          `Wake on LAN sent to ${ok} machine(s)`,
          "Magic packets use the MAC from each agent’s last stored system info.",
        );
      } else if (ok === 0) {
        error(
          "Wake on LAN failed",
          errors
            .slice(0, 3)
            .map((s) => String(s).replace(/^Error: /, ""))
            .join(" · ") + (errors.length > 3 ? " …" : ""),
        );
      } else {
        warning(
          `Wake sent to ${ok}; ${fail} failed`,
          errors
            .slice(0, 2)
            .map((s) => String(s).replace(/^Error: /, ""))
            .join(" · "),
        );
      }
    },
    [agents, error, info, isViewer, warning],
  );

  const control = useCallback(
    (agentIds: string[], cmdType: FleetControlCommand) => {
      if (isViewer) {
        error("Not permitted", "Viewers cannot control agents. Ask an operator or administrator.");
        return;
      }
      const onlineIds = agentIds.filter((id) => agents[id]?.online);
      const offlineCount = agentIds.length - onlineIds.length;

      if (onlineIds.length === 0) {
        warning("No online agents selected", "Select at least one online agent to send this action.");
        return;
      }

      for (const id of onlineIds) {
        send({
          type: "control",
          agent_id: id,
          cmd: { type: cmdType },
        });
      }

      const actionLabel =
        cmdType === "RestartHost" ? "restart" : cmdType === "ShutdownHost" ? "shutdown" : "lock";
      if (offlineCount > 0) {
        warning(
          `Sent ${actionLabel} to ${onlineIds.length} agent(s)`,
          `${offlineCount} offline agent(s) were skipped.`,
        );
      } else {
        info(`Sent ${actionLabel} to ${onlineIds.length} agent(s)`, "Commands queued over WebSocket.");
      }
    },
    [agents, error, info, isViewer, warning, send],
  );

  return useMemo(
    () => ({
      wake,
      lock: (agentIds: string[]) => control(agentIds, "LockHost"),
      restart: (agentIds: string[]) => control(agentIds, "RestartHost"),
      shutdown: (agentIds: string[]) => control(agentIds, "ShutdownHost"),
    }),
    [wake, control],
  );
}
