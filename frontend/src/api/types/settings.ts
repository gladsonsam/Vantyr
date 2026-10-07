// ── Server settings ───────────────────────────────────────────────────────────
// Retention and storage are generated from the server's structs (see ./generated); the local UI
// password state is still built with `json!` and written by hand.

/**
 * Server-side telemetry retention.
 * Global defaults: `null` = unlimited (UI shows 0).
 * Agent override body/response: `null` = inherit global for that field; `0` = unlimited override.
 */
export type { RetentionPolicy } from "./generated/RetentionPolicy";

export type { TableStorage as StorageTableUsage } from "./generated/TableStorage";

/**
 * `database_bytes` is `pg_database_size`; `public_tables_bytes` sums the listed `public`
 * relations (partition children roll into their parent); `other_bytes` is the remainder
 * (system catalogs and structures not tied to a `public` relation).
 */
export type { StorageReport as StorageUsage } from "./generated/StorageReport";

/** Windows agent “Vantyr settings” window lock; hash is server-side only. */
export interface LocalUiPasswordGlobalState {
  password_set: boolean;
}

export interface LocalUiPasswordAgentState {
  global: { password_set: boolean };
  /** `null` = this agent follows the global default (no per-PC row). */
  override: { password_set: boolean } | null;
}
