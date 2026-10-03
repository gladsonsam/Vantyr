import type { ScreenFrameSearchResult } from "../../lib/types";

/** Collapse nearby lookalikes for presentation while retaining every result. */
export function groupSearchHits(hits: readonly ScreenFrameSearchResult[]): ScreenFrameSearchResult[][] {
  const groups: ScreenFrameSearchResult[][] = [];
  for (const hit of hits) {
    const previous = groups[groups.length - 1];
    const first = previous?.[0];
    if (first && first.phash && first.phash === hit.phash && first.snippet === hit.snippet
      && first.monitor === hit.monitor && first.w === hit.w && first.h === hit.h
      && Math.abs(Date.parse(first.captured_at) - Date.parse(hit.captured_at)) <= 5 * 60_000) previous.push(hit);
    else groups.push([hit]);
  }
  return groups;
}
