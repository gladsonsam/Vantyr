import type { ActivitySegmentsResponse, AgentRecallSettings, DaySummaryResponse, FrameTextResponse, HistoryDaysResponse, HistoryMonitorsResponse, RecallContextFilters, RecallSettings, RecallSettingsPatch, ScreenActivityResponse, ScreenFrameAtResponse, ScreenFramesResponse, ScreenSearchResponse } from "@/api/types";
import { get, requestJson, putJson, delJson, apiUrl } from "@/api/client";

/**
 * Shared shape for the Recall range endpoints (frames / activity / days / monitors
 * / search). `monitor` restricts to one display — omitting it interleaves every
 * monitor's frames, which on a multi-head machine makes a timelapse cut between two
 * different screens on alternating frames.
 */
export interface HistoryRangeOpts {
  from?: string;
  to?: string;
  monitor?: number | null;
  limit?: number;
  buckets?: number;
  cursor?: string;
  scope?: "range" | "retained";
  sort?: "ranked" | "newest";
}

/** Context search filters are additive; replay/day APIs remain unfiltered. */
export interface HistorySearchOpts extends HistoryRangeOpts, Partial<RecallContextFilters> {}
export function historySearchQuery(query: string, opts: HistorySearchOpts): string {
  const params = new URLSearchParams(historyRangeQuery(opts));
  params.set("q",query);
  for (const key of ["app","title","url_host","context"] as const) if (opts[key] !== undefined) params.set(key,opts[key] ?? "");
  if (opts.app && opts.app_mode !== undefined) params.set("app_mode",opts.app_mode);
  return `?${params}`;
}

/** `?from=&to=&monitor=&limit=&buckets=` for the Recall range endpoints (omit empty). */
export function historyRangeQuery(opts: HistoryRangeOpts): string {
  const q = new URLSearchParams();
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  // 0 is a valid monitor index, so test for null rather than falsiness.
  if (opts.monitor != null) q.set("monitor", String(opts.monitor));
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.buckets) q.set("buckets", String(opts.buckets));
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.scope) q.set("scope", opts.scope);
  if (opts.sort) q.set("sort", opts.sort);
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

export const recallEndpoints = {
  /** Ids of agents that have recorded at least one Recall screen-history frame. */
  historyDevices: (): Promise<{ agent_ids: string[] }> => get("/agents/history/devices"),

  // ── Screen history / "Recall" (DVR) ────────────────────────────────────────

  /** Frame metadata over a time range (oldest-first) for scrub/timelapse. */
  historyFrames: (id: string, opts: HistoryRangeOpts = {}): Promise<ScreenFramesResponse> =>
    get(`/agents/${id}/history/frames${historyRangeQuery(opts)}`),

  /** The keyframe nearest a given instant (at-or-before, else nearest after). */
  historyFrameAt: (
    id: string,
    atIso?: string,
    monitor?: number | null,
  ): Promise<ScreenFrameAtResponse> => {
    const params = new URLSearchParams();
    if (atIso) params.set("at", atIso);
    if (monitor != null) params.set("monitor", String(monitor));
    const qs = params.toString();
    return get(`/agents/${id}/history/frame${qs ? `?${qs}` : ""}`);
  },

  /** Interactivity histogram (keyframe count per time bucket) for the activity strip. */
  historyActivity: (id: string, opts: HistoryRangeOpts = {}): Promise<ScreenActivityResponse> =>
    get(`/agents/${id}/history/activity${historyRangeQuery(opts)}`),

  /**
   * Which local days hold Recall frames, with counts — feeds the date picker's
   * coverage heatmap so an operator can see where the data is instead of stepping
   * through empty dates. Defaults to the last 90 days server-side.
   */
  historyDays: (id: string, opts: HistoryRangeOpts = {}, signal?: AbortSignal): Promise<HistoryDaysResponse> =>
    requestJson(`/agents/${id}/history/days${historyRangeQuery(opts)}`, { method: "GET", signal }, { includePathInHttpError: true }),

  /** Displays this agent recorded in a range (drives the monitor picker). */
  historyMonitors: (id: string, opts: HistoryRangeOpts = {}): Promise<HistoryMonitorsResponse> =>
    get(`/agents/${id}/history/monitors${historyRangeQuery(opts)}`),

  /**
   * Same-origin URL for a frame's JPEG bytes (session cookie sent automatically
   * by `<img>`). Pass `width` for a cached downscale — the filmstrip, scrubber
   * previews and search results render dozens of frames at once, and full
   * keyframes cost megabytes per interaction. Widths snap server-side to one of a
   * few cacheable buckets.
   */
  historyBlobUrl: (id: string, frameId: number, width?: number): string =>
    apiUrl(`/agents/${id}/history/blob/${frameId}${width ? `?w=${width}` : ""}`),

  /** OCR text + per-word boxes for one frame (drives the selectable-text overlay). */
  historyFrameText: (id: string, frameId: number): Promise<FrameTextResponse> =>
    get(`/agents/${id}/history/text/${frameId}`),

  /** Ranked OCR full-text search over an agent's keyframes in a time range. */
  historySearch: (
    id: string,
    query: string,
    opts: HistorySearchOpts = {},
    signal?: AbortSignal,
  ): Promise<ScreenSearchResponse> => requestJson(`/agents/${id}/history/search${historySearchQuery(query,opts)}`, {method:"GET",signal}, {includePathInHttpError:true}),

  /**
   * Derived activity segments for one day (`YYYY-MM-DD` in the **agent's** local
   * timezone, which the response echoes back; defaults to today there).
   */
  historySegments: (id: string, day?: string): Promise<ActivitySegmentsResponse> =>
    get(`/agents/${id}/history/segments${day ? `?day=${day}` : ""}`),

  /** AI/rule day-narrative + totals for one day (agent-local, as above). */
  historyDaySummary: (id: string, day?: string): Promise<DaySummaryResponse> =>
    get(`/agents/${id}/history/day-summary${day ? `?day=${day}` : ""}`),

  // ── Recall capture settings (fleet default + per-agent override) ───────────

  /** Fleet-wide capture tunables, including the `enabled` kill switch. */
  recallSettingsGet: (): Promise<RecallSettings> => get("/settings/recall"),

  /** Change fleet defaults (admin). Omitted fields keep their current value. */
  recallSettingsPut: (patch: RecallSettingsPatch): Promise<RecallSettings> =>
    putJson("/settings/recall", patch),

  /** All three layers for one agent: effective, its override, and the global default. */
  agentRecallSettingsGet: (id: string): Promise<AgentRecallSettings> =>
    get(`/agents/${id}/history/settings`),

  /**
   * Replace this agent's override (admin). Omitted fields become "inherit the
   * global value" — this is a whole-row replace, not a merge.
   */
  agentRecallSettingsPut: (
    id: string,
    patch: RecallSettingsPatch,
  ): Promise<AgentRecallSettings> => putJson(`/agents/${id}/history/settings`, patch),

  /** Drop the override entirely so the agent inherits every global value again. */
  agentRecallSettingsDelete: (id: string): Promise<{ ok: boolean }> =>
    delJson(`/agents/${id}/history/settings`),
};
