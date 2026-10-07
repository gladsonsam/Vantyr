import type { ApiClient } from "@/api";
import type { ModuleStopRequest } from "@/api/types";
import { asRecord } from "./helpers";
import type { DemoState } from "./state";

/** Fake device module grants endpoints. */
export function demoModulesApi(state: DemoState): Partial<ApiClient> {
  const { moduleStatus } = state;
  return {
    agentModules: async (id) => structuredClone(moduleStatus(String(id))),
    disableAgentModule: async (id, body) => {
      const status = moduleStatus(String(id)), input = asRecord(body);
      const existing = status.pending.find(request => request.command_id === input.command_id);
      if (existing) {
        if (existing.module !== input.module || existing.expected_revision !== input.expected_revision) throw new Error("Stop request binding conflict");
        return structuredClone(existing);
      }
      const grant = status.state?.modules.find(m => m.module === input.module);
      const request: ModuleStopRequest = { command_id: String(input.command_id), agent_id: String(id), module: input.module as ModuleStopRequest["module"], expected_revision: Number(input.expected_revision), status: "queued", error: null, created_at: new Date().toISOString(), acknowledged_at: null, persisted: false, stopped: false, stop_status: "unconfirmed", pending: true };
      if (!grant || grant.revision !== request.expected_revision) request.status = "stale";
      else if (status.online && status.state) {
        grant.enabled = false; grant.authorization_required = true; grant.revision = ++status.state.revision;
        status.reported_at = new Date().toISOString(); request.status = "disabled"; request.persisted = true; request.pending = false;
      }
      status.pending = [request, ...status.pending].slice(0, 50);
      return structuredClone(request);
    },
  };
}
