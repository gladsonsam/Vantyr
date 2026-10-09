import type { RecallCaptureContext } from "@/api/types";

export const DEMO_FRAME_STEP_MS = 90_000;

/** One synthetic keyframe at epoch-millis `t`. Id is derived from `t` so it is
 *  stable across `historyFrames` / `historyFrameAt` / the blob URL. */
export function demoFrame(t: number): {
  id: number;
  captured_at: string;
  monitor: number;
  w: number;
  h: number;
  phash: string;
  has_ocr: boolean;
  context: RecallCaptureContext | null;
  capture_duration_ms: number | null;
} {
  const id = Math.round(t / 1000);
  const contextKind=Math.abs(Math.round(t/DEMO_FRAME_STEP_MS))%5;
  return {
    id,
    captured_at: new Date(t).toISOString(),
    monitor: 0,
    w: 1600,
    h: 900,
    phash: String((id * 2654435761) % 1_000_000_000),
    has_ocr: id % 3 === 0,
    capture_duration_ms:contextKind===0 ? null : 24,
    // Synthetic observations only; demo does not capture OS/window/browser context.
    context:contextKind===0 ? null : {
      version:1,scope:"session_foreground",bracket_ms:48,monitor_relation:"unknown",
      window:contextKind===1 ? {status:"uncertain",reason:"changed",source:"none",app:null,title:null} : contextKind===2 ? {status:"not_collected",reason:"module_disabled",source:"none",app:null,title:null} : {status:"observed",reason:null,source:"win32",app:contextKind===3 ? "Editor.EXE" : "Browser.EXE",title:contextKind===3 ? "Documentation" : "Project dashboard"},
      browser:{status:"unknown",reason:"unsupported",source:"none",url:null,url_host:null},
    },
  };
}

/** Synthetic frame list across [fromMs, toMs], one every DEMO_FRAME_STEP_MS. */
export function demoFramesList(fromMs: number, toMs: number): ReturnType<typeof demoFrame>[] {
  const frames: ReturnType<typeof demoFrame>[] = [];
  const start = Math.ceil(fromMs / DEMO_FRAME_STEP_MS) * DEMO_FRAME_STEP_MS;
  for (let t = start; t <= toMs && frames.length < 10000; t += DEMO_FRAME_STEP_MS) {
    frames.push(demoFrame(t));
  }
  return frames;
}

/** Synthetic activity segments for a given day (YYYY-MM-DD). */
/** The demo "agent" lives in the viewer's own zone, so the demo day matches the clock. */
/** Fleet-default capture tunables the demo reports (matches the migration defaults). */
export const demoRecallSettings = {
  enabled: true,
  interval_ms: 20000,
  hot_interval_ms: 6000,
  jpeg_quality: 45,
  max_dim: 1600,
  dedup_hamming: 4,
  keyframe_max_gap_ms: 300000,
  ocr: true,
};

/**
 * Normalize a `HistoryRangeOpts` argument arriving as `unknown` (the demo overrides
 * are typed loosely so one Proxy can stand in for the whole client).
 */
export function demoRange(opts: unknown): {
  from: number;
  to: number;
  limit: number;
  buckets: number;
} {
  const o = (opts ?? {}) as { from?: string; to?: string; limit?: number; buckets?: number };
  const to = o.to ? new Date(o.to).getTime() : Date.now();
  const from = o.from ? new Date(o.from).getTime() : to - 24 * 3600 * 1000;
  return {
    from,
    to,
    limit: typeof o.limit === "number" ? o.limit : 0,
    buckets: typeof o.buckets === "number" ? o.buckets : 0,
  };
}

export function demoTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Today as a local `YYYY-MM-DD` (not the UTC date `toISOString` would give). */
export function demoToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function demoSegments(day: string): {
  id: number;
  start_ts: string;
  end_ts: string;
  category: string;
  app: string | null;
  title: string | null;
  summary: string | null;
  distraction_score: number;
  source: string;
}[] {
  const plan: [string, string, string, number, number][] = [
    // [category, app, title, minutes, distraction]
    ["dev", "Code.exe", "RecallPage.tsx — vantyr", 95, 0.1],
    ["terminal", "WindowsTerminal.exe", "cargo check -p vantyr-server", 25, 0.1],
    ["browsing", "chrome.exe", "postgres partitioning docs", 30, 0.5],
    ["comms", "slack.exe", "#eng-vantyr", 20, 0.4],
    ["media", "chrome.exe", "youtube.com — lofi", 15, 0.85],
    ["docs", "Code.exe", "11-screen-history-plan.md", 40, 0.2],
    ["dev", "Code.exe", "screen_narrative.rs", 70, 0.1],
  ];
  // Anchor the sequence to end at ~now (clamped to the selected day) so the segments
  // fall inside the rolling frame window — makes click-to-jump land on a real frame.
  const spanMin = plan.reduce((n, p) => n + p[3], 0) + (plan.length - 1) * 3;
  const dayEnd = new Date(`${day}T23:59:59`).getTime();
  const anchorEnd = Math.min(dayEnd, Date.now());
  let t = anchorEnd - spanMin * 60_000;
  return plan.map(([category, app, title, mins, distraction], i) => {
    const start = t;
    const end = t + mins * 60_000;
    t = end + 3 * 60_000;
    return {
      id: i + 1,
      start_ts: new Date(start).toISOString(),
      end_ts: new Date(end).toISOString(),
      category,
      app,
      title,
      summary: `${app} — ${title}`,
      distraction_score: distraction,
      source: "rule",
    };
  });
}

/** A mock "screenshot" as an inline SVG data URI, keyed off the frame id. Chrome stays
 *  neutral dark so no frame reads as an alert; only a faint hue wash varies per frame. */
export function demoFrameDataUri(frameId: number): string {
  const hue = ((frameId % 360) + 360) % 360;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900'>` +
    `<rect width='100%' height='100%' fill='#101216'/>` +
    `<rect width='1600' height='56' fill='#171a20'/>` +
    `<circle cx='40' cy='28' r='9' fill='#20dd8f'/>` +
    `<text x='68' y='37' fill='#e6e6e6' font-family='monospace' font-size='24'>Demo desktop &#183; frame ${frameId}</text>` +
    `<rect x='120' y='150' width='1360' height='620' rx='14' fill='hsl(${hue},12%,13%)' stroke='rgba(255,255,255,0.09)' stroke-width='2'/>` +
    `<text x='160' y='230' fill='#9fb3ad' font-family='monospace' font-size='30'>Recall keyframe (mock preview)</text>` +
    `<text x='160' y='290' fill='#6b7d78' font-family='monospace' font-size='22'>1600 &#215; 900 &#183; monitor 0</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
