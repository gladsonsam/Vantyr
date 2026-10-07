// ── Recall (screen history) ──────────────────────────────────────────────────
//
// Item shapes are generated from the server's Rust structs and the shared protocol crate
// (`./generated`, see server/docs/ARCHITECTURE.md). The response envelopes the server still
// builds with `json!` are written by hand below and mirror those handlers field for field.

import type { ActivityPoint } from "./generated/ActivityPoint";
import type { ActivitySegment } from "./generated/ActivitySegment";
import type { CoverageDay } from "./generated/CoverageDay";
import type { DaySummary } from "./generated/DaySummary";
import type { FrameMeta } from "./generated/FrameMeta";
import type { RecallContextFilters } from "./generated/RecallContextFilters";
import type { RecallSettings } from "./generated/RecallSettings";
import type { RecallSettingsOverride } from "./generated/RecallSettingsOverride";
import type { RecordedMonitor } from "./generated/RecordedMonitor";

// ── Capture context (Recall frames) ─────────────────────────────────────────

/** Capture-associated observations. These are never atomic pixel attribution. */
export type { RecallContextStatus } from "./generated/RecallContextStatus";
export type { RecallContextReason } from "./generated/RecallContextReason";
export type { RecallWindowContext } from "./generated/RecallWindowContext";
export type { RecallBrowserContext } from "./generated/RecallBrowserContext";
export type { RecallCaptureContext } from "./generated/RecallCaptureContext";
export type { RecallContextFilters } from "./generated/RecallContextFilters";

// ── Screen history / "Recall" ───────────────────────────────────────────────

/**
 * Metadata for one persisted screen keyframe (the JPEG bytes are fetched separately).
 * `phash` is the u64 perceptual hash as a decimal string; `context` is `null` on legacy frames.
 */
export type ScreenFrame = FrameMeta;

export interface ScreenFramesResponse {
  from: string;
  to: string;
  monitor: number | null;
  count: number;
  frames: ScreenFrame[];
  limit: number;
  // This server always sends the paging fields; `loadFramePages` still tolerates a response
  // without them (an older server) rather than claiming the history is complete.
  has_more?: boolean;
  complete?: boolean;
  next_cursor?: string | null;
}

export interface ScreenFrameAtResponse {
  frame: ScreenFrame | null;
}

/** One local day with Recall coverage, for the date picker's coverage heatmap. */
export type HistoryDay = CoverageDay;

export interface HistoryDaysResponse {
  from: string;
  to: string;
  /** IANA zone the days are bucketed in — the agent's, not the viewer's. */
  timezone: string;
  count: number;
  days: HistoryDay[];
}

/** One display this agent recorded in a range. */
export type HistoryMonitor = RecordedMonitor;

export interface HistoryMonitorsResponse {
  from: string;
  to: string;
  monitors: HistoryMonitor[];
}

/** Recall capture tunables. The global row, and the shape of a per-agent override. */
export type { RecallSettings, RecallSettingsOverride };

/** A patch: omitted fields are left alone globally, or inherited per-agent. */
export type RecallSettingsPatch = Partial<RecallSettings>;

/**
 * All three layers for one agent, so the UI can show inherited values as inherited
 * rather than as deliberate local choices.
 */
export interface AgentRecallSettings {
  /** What the agent is actually told to do. */
  effective: RecallSettings | null;
  /** The per-agent row, or `null` when the agent has no override at all. */
  override: RecallSettingsOverride | null;
  /** The fleet default this agent inherits from. */
  global: RecallSettings;
}

/** One bucket of the interactivity histogram: keyframe count in a time window. */
export type { ActivityPoint };

export interface ScreenActivityResponse {
  from: string;
  to: string;
  bucket_secs: number;
  points: ActivityPoint[];
}

/** One OCR full-text search hit: frame metadata + relevance + highlighted snippet. */
export type ScreenFrameSearchResult = ScreenFrame & Required<Pick<FrameMeta, "rank" | "snippet">>;

export interface ScreenSearchResponse {
  query: string;
  from: string | null;
  to: string;
  filters: RecallContextFilters;
  count: number;
  results: ScreenFrameSearchResult[];
  monitor: number | null;
  scope: "range" | "retained";
  sort: "ranked" | "newest";
  limit: number;
  has_more?: boolean;
  complete?: boolean;
  next_cursor?: string | null;
}

/** One derived activity segment (Phase 3 narrative). */
export type { ActivitySegment };

export interface ActivitySegmentsResponse {
  day: string;
  /** IANA zone the `day` is expressed in — the agent's, not the viewer's. */
  timezone: string;
  count: number;
  segments: ActivitySegment[];
}

/**
 * One OCR'd word and its box on a keyframe, normalized to 0..1 of the frame — so the
 * overlay positions correctly regardless of capture resolution or rendered size.
 */
export type { OcrWord } from "./generated/OcrWord";

/** OCR text + word geometry for one frame, fetched lazily for the visible frame. */
export type { FrameText as FrameTextResponse } from "./generated/FrameText";

/** Per-day summary: AI/rule narrative + aggregate totals. */
export type { DaySummary };

export interface DaySummaryResponse {
  day: string;
  /** IANA zone the `day` is expressed in — the agent's, not the viewer's. */
  timezone: string;
  summary: DaySummary | null;
}
