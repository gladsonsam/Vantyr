// ── Device modules (per-agent capability grants) ──────────────────────────────

export interface DeviceModuleGrant { module: string; available: boolean; enabled: boolean; revision: number; authorization_required: boolean }
export interface DeviceModuleReport { schema_version: number; revision: number; modules: DeviceModuleGrant[] }
export interface ModuleStopRequest { command_id: string; module: string; expected_revision: number; status: string; error?: string | null; created_at?: string; persisted?: boolean; stopped?: boolean; stop_status?: string }
export interface DeviceModuleStatus { state: DeviceModuleReport | null; online: boolean; reported_at: string | null; pending: ModuleStopRequest[]; authorization_current?: boolean }
