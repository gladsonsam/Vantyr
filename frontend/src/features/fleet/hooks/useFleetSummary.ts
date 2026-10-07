import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/api";
import type { FleetAgentSummary, FleetSummaryResponse } from "@/api/types";
import { fleetServerScope } from "@/hooks/useVerifiedUser";
import { onSessionExpired } from "@/api/sessionExpiry";

export type FleetEnrichment = { status: "ready"; summary: FleetAgentSummary } | { status: "loading" | "missing" | "error" };
export const FLEET_BATCH_SIZE = 100;
export const FLEET_CONCURRENCY = 3;
const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Fail a malformed batch instead of turning absent fields into healthy defaults. */
function validateBatch(value: unknown): asserts value is FleetSummaryResponse {
  if (!object(value) || !object(value.agents) || !Array.isArray(value.missing) || value.missing.some(id => typeof id !== "string")) throw new Error("Invalid fleet summary response");
  for (const entry of Object.values(value.agents)) {
    if (!object(entry) || !(entry.info === null || object(entry.info))
      || !(entry.info_reported_at === null || typeof entry.info_reported_at === "string")
      || !(entry.last_window === null || object(entry.last_window) && typeof entry.last_window.app === "string" && typeof entry.last_window.title === "string" && typeof entry.last_window.reported_at === "string")
      || typeof entry.internet_blocked !== "boolean"
      || ![null, "all", "group", "agent"].includes(entry.internet_block_source as string | null)
      || typeof entry.app_block_enabled_count !== "number" || !Number.isSafeInteger(entry.app_block_enabled_count) || entry.app_block_enabled_count < 0) throw new Error("Invalid fleet summary entry");
  }
}

interface Job { controller: AbortController; run: () => Promise<void> }
/** Keep the three slots across scope changes, including fetches slow to abort.
 * Replace queued work on invalidation; obsolete promises cannot create fanout. */
class BatchLane {
  private active = new Set<Job>();
  private queue: Job[] = [];
  replace(jobs: Job[]) { this.cancel(); this.queue = jobs; this.pump(); }
  cancel() { this.queue = []; for (const job of this.active) job.controller.abort(); }
  private pump() {
    while (this.active.size < FLEET_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!; this.active.add(job);
      void job.run().finally(() => { this.active.delete(job); this.pump(); });
    }
  }
}
function subscribeServer(callback: () => void) {
  window.addEventListener("storage", callback); window.addEventListener("focus", callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener("focus", callback); };
}

/** Caller supplies its verified server/user preference scope. No enrichment is
 * shown or fetched while identity is unverified. Live telemetry stays in caller.
 * One round per ID-set/scope change, then every 60s after the prior round settles. */
export function useFleetSummary(ids: readonly string[], scope: string | null) {
  const server = useSyncExternalStore(subscribeServer, fleetServerScope, () => "");
  const idsKey = JSON.stringify([...new Set(ids)].sort());
  const ordered = useMemo<string[]>(() => JSON.parse(idsKey), [idsKey]);
  const [expired, setExpired] = useState(false);
  const blocked = useRef(false);
  const key = JSON.stringify([scope, server, idsKey, expired]);
  const currentKey = useRef(key);
  const lane = useRef<BatchLane | null>(null);
  if (lane.current == null) lane.current = new BatchLane();
  // The fetch jobs below compare against this between renders; mirror the
  // latest key here so they never close over a stale render snapshot.
  useEffect(() => {
    currentKey.current = key;
  });
  const [state, setState] = useState<{ key: string; entries: Record<string, FleetEnrichment> }>({ key: "", entries: {} });
  useEffect(() => { blocked.current = false; setExpired(false); }, [scope]);
  useEffect(() => onSessionExpired(() => { blocked.current = true; lane.current!.cancel(); setExpired(true); }), []);
  useEffect(() => {
    let alive = true;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const valid = () => alive && !blocked.current && currentKey.current === key && fleetServerScope() === server;
    const start = () => {
      if (!valid() || !scope || expired || !ordered.length) return;
      let remaining = Math.ceil(ordered.length / FLEET_BATCH_SIZE);
      const jobs: Job[] = [];
      for (let i = 0; i < ordered.length; i += FLEET_BATCH_SIZE) {
        const batch = ordered.slice(i, i + FLEET_BATCH_SIZE), controller = new AbortController();
        jobs.push({ controller, run: async () => {
          const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          const entries: Record<string, FleetEnrichment> = {};
          try {
            const response = await api.fleetSummary(batch, controller.signal);
            if (controller.signal.aborted) throw new Error("Fleet summary request cancelled");
            validateBatch(response);
            const missing = new Set(response.missing);
            for (const id of batch) {
              const summary = Object.prototype.hasOwnProperty.call(response.agents, id) ? response.agents[id] : undefined;
              // Missing wins over an inconsistent duplicate entry. An omitted ID
              // without an explicit missing marker is a protocol error, not zero.
              entries[id] = missing.has(id) ? { status: "missing" } : summary ? { status: "ready", summary } : { status: "error" };
            }
          } catch { for (const id of batch) entries[id] = { status: "error" }; }
          finally { clearTimeout(timeout); }
          if (valid()) {
            setState(previous => valid() ? { key, entries: { ...(previous.key === key ? previous.entries : {}), ...entries } } : previous);
            if (--remaining === 0) refresh = setTimeout(start, REFRESH_MS);
          }
        } });
      }
      lane.current!.replace(jobs);
    };
    setState({ key, entries: {} }); start();
    return () => { alive = false; clearTimeout(refresh); lane.current!.cancel(); };
  }, [key, ordered, scope, server, expired]);
  return state.key === key && !expired ? state.entries : {};
}
