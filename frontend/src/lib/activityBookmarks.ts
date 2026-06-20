import type { ActivityUrlStateV1 } from "./activityUrl";

export type ActivityBookmark = {
  id: string;
  name: string;
  created_at: string; // ISO
  state: ActivityUrlStateV1;
};

const STORAGE_KEY = "vantyr.activity_bookmarks.v1";

function storageKeyForAgent(agentId: string): string {
  return `${STORAGE_KEY}:${agentId}`;
}

export function listActivityBookmarks(agentId: string): ActivityBookmark[] {
  try {
    const raw = localStorage.getItem(storageKeyForAgent(agentId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === "object")
      .map((x) => x as ActivityBookmark)
      .filter((b) => typeof b.id === "string" && typeof b.name === "string" && b.state?.v === 1);
  } catch {
    return [];
  }
}

export function upsertActivityBookmark(agentId: string, b: ActivityBookmark): void {
  try {
    const xs = listActivityBookmarks(agentId).filter((x) => x.id !== b.id);
    xs.unshift(b);
    // Hard cap to keep localStorage bounded.
    const capped = xs.slice(0, 50);
    localStorage.setItem(storageKeyForAgent(agentId), JSON.stringify(capped));
  } catch {
    /* ignore */
  }
}

export function deleteActivityBookmark(agentId: string, id: string): void {
  try {
    const xs = listActivityBookmarks(agentId).filter((x) => x.id !== id);
    localStorage.setItem(storageKeyForAgent(agentId), JSON.stringify(xs));
  } catch {
    /* ignore */
  }
}

export function newBookmarkId(): string {
  return crypto.randomUUID();
}
