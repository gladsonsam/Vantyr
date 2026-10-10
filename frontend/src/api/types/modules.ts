// ── Device modules (per-agent capability grants) ──────────────────────────────
// Generated from the server's module structs and the shared protocol crate; see ./generated.

export type { Module as DeviceModuleId } from "./generated/Module";
export type { ModuleState as DeviceModuleGrant } from "./generated/ModuleState";
export type { ModuleReport as DeviceModuleReport } from "./generated/ModuleReport";
export type { ModuleDisableRequest as ModuleStopRequest } from "./generated/ModuleDisableRequest";
export type { ModulesResponse as DeviceModuleStatus } from "./generated/ModulesResponse";
