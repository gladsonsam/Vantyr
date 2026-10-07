import type { DeviceModuleId, DeviceModuleStatus, ModuleStopRequest } from "@/api/types";
import { get, postJsonRes } from "@/api/client";

export const modulesEndpoints = {
  agentModules: (agentId: string): Promise<DeviceModuleStatus> => get(`/agents/${agentId}/modules`),
  disableAgentModule: (agentId: string, body: { module: DeviceModuleId; expected_revision: number; command_id: string }): Promise<ModuleStopRequest> => postJsonRes(`/agents/${agentId}/modules/disable`, body),
};
