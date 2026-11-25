import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RecallScrubber } from "@/features/recall/components/RecallScrubber";
vi.mock("@/api", () => ({ api: { historyBlobUrl: () => "/capture" } }));
const frame = (id: number, iso: string) => ({ id, captured_at: iso, monitor: 0, w: 1, h: 1, phash: "0", has_ocr: false, context: null, capture_duration_ms: null });
function show(frames: ReturnType<typeof frame>[]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host);
  act(() => root.render(<RecallScrubber agentId="a" frames={frames} fromMs={Date.parse("2026-10-03T00:00:00Z")} toMs={Date.parse("2026-10-03T03:00:00Z")} playheadMs={Date.parse("2026-10-03T01:00:00Z")} onSeek={vi.fn()} activity={null} timezone="UTC" />));
  return { host, done: () => act(() => root.unmount()) };
}
it("states what the bar means and counts gaps between captures", () => {
  const { host, done } = show([frame(1, "2026-10-03T00:00:00Z"), frame(2, "2026-10-03T00:02:00Z"), frame(3, "2026-10-03T01:30:00Z"), frame(4, "2026-10-03T02:50:00Z")]);
  try {
    expect(host.textContent).toContain("Green marks captures; blank stretches have none");
    expect(host.textContent).toContain("2 gaps in this range");
    expect(host.querySelector('[role="slider"]')!.getAttribute("aria-label")).toBe("Playhead");
  } finally { done(); }
});
it("does not claim gaps when captures are continuous", () => {
  const { host, done } = show([frame(1, "2026-10-03T00:00:00Z"), frame(2, "2026-10-03T00:03:00Z")]);
  try { expect(host.textContent).not.toContain("gap"); } finally { done(); }
});
