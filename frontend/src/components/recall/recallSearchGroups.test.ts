import { expect, it } from "vitest";
import type { ScreenFrameSearchResult } from "@/api/types";
import { groupSearchHits } from "./recallSearchGroups";
const hit = (id: number, patch: Partial<ScreenFrameSearchResult> = {}): ScreenFrameSearchResult => ({ id, captured_at: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(), monitor: 0, w: 1920, h: 1080, phash: "18446744073709551615", snippet: "[[[invoice]]]", has_ocr: true, rank: 1, ...patch });
it("groups nearby similar matches without deleting, reordering or rounding fingerprints", () => {
  const hits = [hit(1), hit(2), hit(3, { phash: "18446744073709551614" }), hit(4)];
  const groups = groupSearchHits(hits);
  expect(groups.map(g => g.map(h => h.id))).toEqual([[1, 2], [3], [4]]);
  expect(groups.flat()).toEqual(hits);
});
it("keeps distinct displays, excerpts, resolutions and distant moments separate", () => {
  const hits = [hit(1), hit(2, { monitor: 1 }), hit(3, { snippet: "[[[payment]]]" }), hit(4, { w: 1080 }), hit(15)];
  expect(groupSearchHits(hits).map(g => g.length)).toEqual([1, 1, 1, 1, 1]);
  expect(groupSearchHits([hit(1, { phash: "" }), hit(2, { phash: "" })])).toHaveLength(2);
});
