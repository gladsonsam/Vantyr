/**
 * Server-side telemetry retention.
 * Global defaults: `null` = unlimited (UI shows 0).
 * Agent override body/response: `null` = inherit global for that field; `0` = unlimited override.
 */
export interface RetentionPolicy {
  keylog_days: number | null;
  window_days: number | null;
  url_days: number | null;
}

export interface StorageTableUsage {
  name: string;
  bytes: number;
}

export interface StorageUsage {
  /** `pg_database_size(current database)` — full on-disk size for this DB (tables, indexes, TOAST, etc.). */
  database_bytes: number;
  /** Sum of `pg_total_relation_size` for listed `public` relations (see server; excludes partition children). */
  public_tables_bytes: number;
  /** Remainder: system catalogs (`pg_catalog`, etc.), internal structures not tied to a `public` rel. */
  other_bytes: number;
  tables: StorageTableUsage[];
}

/** Windows agent “Vantyr settings” window lock; hash is server-side only. */
export interface LocalUiPasswordGlobalState {
  password_set: boolean;
}

export interface LocalUiPasswordAgentState {
  global: { password_set: boolean };
  /** `null` = this agent follows the global default (no per-PC row). */
  override: { password_set: boolean } | null;
}
