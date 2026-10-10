import type { ScreenFrame, ScreenFramesResponse } from "@/api/types";

export interface FrameLoadProgress {
  frames: ScreenFrame[];
  complete: boolean | null;
}

/** Load metadata incrementally; cancellation prevents another page and stale UI updates. */
export async function loadFramePages(
  fetchPage: (cursor?: string) => Promise<ScreenFramesResponse>,
  onProgress: (progress: FrameLoadProgress) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const byId = new Map<number, ScreenFrame>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (isCurrent()) {
    const page = await fetchPage(cursor);
    if (!isCurrent()) return;
    for (const frame of page.frames) byId.set(frame.id, frame);
    const next = page.next_cursor ?? undefined;
    if (page.has_more && !next) throw new Error("History response is incomplete but has no continuation cursor.");
    if (next && cursors.has(next)) throw new Error("History pagination did not advance. Reload to retry.");
    const frames = [...byId.values()].sort((a, b) =>
      Date.parse(a.captured_at) - Date.parse(b.captured_at) || a.id - b.id);
    onProgress({ frames, complete: next ? false : page.complete ?? null });
    if (!next) return;
    cursors.add(next);
    cursor = next;
  }
}
