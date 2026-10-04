import type { FleetRow } from "./types";

/** These reads describe configured policy, never observed device enforcement. */
export function FleetPolicySummary({ row }: { row: FleetRow }) {
  const unknown = row.internetBlocked == null || row.appBlockEnabledCount == null;
  const explanation = "Configuration only. Scheduled internet blocking and current device enforcement are unknown.";
  return <div style={{ fontSize: 10.5, marginTop: 4, marginBottom: 10 }} title={explanation}>
    {unknown ? <span style={{ color: "var(--tx-3)" }}>{row.enrichmentStatus === "missing" ? "Device absent from fleet summary" : row.enrichmentStatus === "error" ? "Policy configuration unavailable" : "Loading policy configuration…"}</span> : <>
      <div style={{ color: row.internetBlocked ? "var(--red)" : "var(--tx-3)" }}>{row.internetBlocked ? "Internet block configured" : "No always-on internet block"}</div>
      <div style={{ color: row.appBlockEnabledCount ? "var(--amber)" : "var(--tx-3)" }}>Enabled app rules: {row.appBlockEnabledCount}</div>
    </>}
  </div>;
}
