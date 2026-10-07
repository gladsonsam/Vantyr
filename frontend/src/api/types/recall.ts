// ── Capture context (Recall frames) ─────────────────────────────────────────

/** Capture-associated observations. These are never atomic pixel attribution. */
export type RecallContextStatus = "observed" | "uncertain" | "unknown" | "not_collected";
export type RecallContextReason = "module_disabled" | "revoked" | "unsupported" | "no_foreground" | "not_browser" | "read_failed" | "sample_timeout" | "changed" | "identity_unverified" | "invalid_url" | "invalid_context";
export interface RecallWindowContext {
  status: RecallContextStatus; reason: RecallContextReason | null;
  source: "win32" | "hyprland" | "none"; app: string | null; title: string | null; title_truncated?: boolean;
}
export interface RecallBrowserContext {
  status: RecallContextStatus; reason: RecallContextReason | null;
  source: "uia_hwnd" | "none"; url: null; url_host: string | null;
}
export interface RecallCaptureContext {
  version: 1; scope: "session_foreground"; bracket_ms: number;
  monitor_relation: "unknown" | "same" | "other";
  window: RecallWindowContext; browser: RecallBrowserContext;
}
export interface RecallContextFilters {
  app: string | null; app_mode: "exact" | "prefix"; title: string | null;
  url_host: string | null; context: "all" | "known" | "unknown";
}

// ── Screen history / "Recall" ───────────────────────────────────────────────

/** Metadata for one persisted screen keyframe (the JPEG bytes are fetched separately). */
export interface ScreenFrame {
  /** Global frame id; use with the blob endpoint. */
  id: number;
  captured_at: string;
  monitor: number;
  w: number;
  h: number;
  /** u64 perceptual (aHash) as a decimal string (JS can't hold a full u64). */
  phash: string;
  /** Whether this frame has OCR text (searchable in Phase 2). */
  has_ocr: boolean;
  /** Missing on legacy responses; never reconstructed from live activity. */
  context?: RecallCaptureContext | null;
  capture_duration_ms?: number | null;
}

export interface ScreenFramesResponse {
  from: string;
  to: string;
  count: number;
  frames: ScreenFrame[];
  has_more?: boolean;
  complete?: boolean;
  next_cursor?: string | null;
}

export interface ScreenFrameAtResponse {
  frame: ScreenFrame | null;
}

/** One local day with Recall coverage, for the date picker's coverage heatmap. */
export interface HistoryDay {
  /** `YYYY-MM-DD` in the agent's zone. */
  day: string;
  frame_count: number;
  first_ts: string | null;
  last_ts: string | null;
  /** Whether a day narrative has been derived yet. */
  has_summary: boolean;
}

export interface HistoryDaysResponse {
  from: string;
  to: string;
  /** IANA zone the days are bucketed in — the agent's, not the viewer's. */
  timezone: string;
  count: number;
  days: HistoryDay[];
}

/** One display this agent recorded in a range. */
export interface HistoryMonitor {
  /** 0-based display index, as captured. */
  monitor: number;
  frame_count: number;
  w: number;
  h: number;
}

export interface HistoryMonitorsResponse {
  from: string;
  to: string;
  monitors: HistoryMonitor[];
}

/** Recall capture tunables. The global row, and the shape of a per-agent override. */
export interface RecallSettings {
  /** Operator kill switch: false stops the agent capturing at all. */
  enabled: boolean;
  /** Cadence while active but not interacting (ms). */
  interval_ms: number;
  /** Faster cadence while actively interacting (ms). */
  hot_interval_ms: number;
  jpeg_quality: number;
  /** Longest edge after downscale (px); 0 disables downscaling. */
  max_dim: number;
  /** Skip frames within this Hamming distance of the last stored one. */
  dedup_hamming: number;
  /** Force a keyframe at least this often even if the screen looks unchanged (ms). */
  keyframe_max_gap_ms: number;
  /** Run on-device OCR, making screens searchable. */
  ocr: boolean;
}

/** A per-agent override row: `null` in a field means "inherit the global value". */
export type RecallSettingsOverride = {
  [K in keyof RecallSettings]: RecallSettings[K] | null;
} & { updated_at?: string | null };

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
export interface ActivityPoint {
  /** Bucket start, epoch seconds. */
  t: number;
  count: number;
}

export interface ScreenActivityResponse {
  from: string;
  to: string;
  bucket_secs: number;
  points: ActivityPoint[];
}

/** One OCR full-text search hit: frame metadata + relevance + highlighted snippet. */
export interface ScreenFrameSearchResult extends ScreenFrame {
  /** ts_rank relevance score. */
  rank: number;
  /** Plain ts_headline snippet with [[[matches]]] delimiters; context-only is empty. */
  snippet: string;
}

export interface ScreenSearchResponse {
  filters?: RecallContextFilters;
  query: string;
  from: string | null;
  to: string;
  count: number;
  results: ScreenFrameSearchResult[];
  scope?: "range" | "retained";
  sort?: "ranked" | "newest";
  has_more?: boolean;
  complete?: boolean;
  next_cursor?: string | null;
}

/** One derived activity segment (Phase 3 narrative). */
export interface ActivitySegment {
  id: number;
  start_ts: string;
  end_ts: string;
  category: string;
  app: string | null;
  title: string | null;
  summary: string | null;
  distraction_score: number;
  source: string;
}

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
export interface OcrWord {
  /** The word text. */
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** OCR text + word geometry for one frame, fetched lazily for the visible frame. */
export interface FrameTextResponse {
  text: string | null;
  words: OcrWord[];
}

/** Per-day summary: AI/rule narrative + aggregate totals. */
export interface DaySummary {
  day: string | null;
  narrative: string | null;
  totals: {
    active_seconds?: number;
    segment_count?: number;
    by_category?: Record<string, number>;
  };
  top_apps: { app: string; seconds: number }[];
  highlights: { label: string; category: string; start_ts: string; end_ts: string }[];
  source: string;
  updated_at: string | null;
}

export interface DaySummaryResponse {
  day: string;
  /** IANA zone the `day` is expressed in — the agent's, not the viewer's. */
  timezone: string;
  summary: DaySummary | null;
}
