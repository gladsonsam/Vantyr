import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { parseTimestamp } from "../lib/utils";

const CLEAR_INFERRED_WS = new Set(["active", "keys", "window_focus", "url"]);

/**
 * Derives idle seconds from the latest AFK activity row when there is no newer
 * keys/windows/URL telemetry; clears on live "active" or relevant WebSocket events.
 */
export function useAgentInferredIdle(
  agentId: string,
  liveActivity: "afk" | "active" | undefined,
) {
  const [inferredIdleSeconds, setInferredIdleSeconds] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadLastActivity = async () => {
      try {
        const { rows } = await api.activity(agentId, { limit: 1, offset: 0 }).catch(() => ({
          rows: [],
        }));
        const row = rows[0];
        if (!row || cancelled) return;
        const eventType = String(
          (row as { event_type?: string }).event_type ?? row.kind ?? "",
        ).toLowerCase();
        if (eventType !== "afk") {
          if (!cancelled) setInferredIdleSeconds(null);
          return;
        }
        const idleAtTransition = Number(
          (row as { idle_seconds?: number }).idle_seconds ?? row.idle_secs ?? 0,
        );
        const tsRaw = row.ts;
        const afkTs = parseTimestamp(tsRaw);
        if (!afkTs) return;

        const [keysData, winData, urlData] = await Promise.all([
          api.keys(agentId, { limit: 1, offset: 0 }).catch(() => ({ rows: [] as const })),
          api.windows(agentId, { limit: 1, offset: 0 }).catch(() => ({ rows: [] as const })),
          api.urls(agentId, { limit: 1, offset: 0 }).catch(() => ({ rows: [] as const })),
        ]);

        const newestAfterAfk = (body: { rows?: unknown }, tsKeys: string[]): Date | null => {
          const arr = Array.isArray(body?.rows)
            ? (body.rows as Record<string, unknown>[])
            : [];
          const r = arr[0];
          if (!r) return null;
          for (const k of tsKeys) {
            const d = parseTimestamp(String(r[k] ?? ""));
            if (d && d.getTime() > afkTs.getTime()) return d;
          }
          return null;
        };

        let hasNewerTelemetry = newestAfterAfk(keysData, [
          "updated_at",
          "timestamp",
          "ts",
          "started_at",
        ]) != null;
        if (!hasNewerTelemetry) {
          hasNewerTelemetry =
            newestAfterAfk(winData, ["timestamp", "ts", "created"]) != null;
        }
        if (!hasNewerTelemetry) {
          hasNewerTelemetry = newestAfterAfk(urlData, ["timestamp", "ts"]) != null;
        }

        if (hasNewerTelemetry) {
          if (!cancelled) setInferredIdleSeconds(null);
          return;
        }

        const nowMs = Date.now();
        const base = Number.isFinite(idleAtTransition) && idleAtTransition > 0 ? idleAtTransition : 0;
        const extra = Math.max(0, Math.floor((nowMs - afkTs.getTime()) / 1000));
        if (!cancelled) setInferredIdleSeconds(base + extra);
      } catch {
        /* ignore — header omits inferred idle */
      }
    };
    void loadLastActivity();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (liveActivity === "active") {
      setInferredIdleSeconds(null);
    }
  }, [liveActivity]);

  useEffect(() => {
    const onWs = (e: Event) => {
      const d = (e as CustomEvent<{ agent_id?: string; event?: string }>).detail;
      if (!d || d.agent_id !== agentId) return;
      const ev = String(d.event ?? "");
      if (CLEAR_INFERRED_WS.has(ev)) {
        setInferredIdleSeconds(null);
      }
    };
    window.addEventListener("vantyr-ws-event", onWs as EventListener);
    return () => window.removeEventListener("vantyr-ws-event", onWs as EventListener);
  }, [agentId]);

  return inferredIdleSeconds;
}
