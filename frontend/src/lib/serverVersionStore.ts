import { useSyncExternalStore } from "react";

/** Payload from `GET /settings/version` (shared across dashboard). */
export interface SettingsVersionPayload {
  server_version: string;
  latest_server_release: string | null;
  server_update_available: boolean;
  latest_agent_version: string | null;
  releases_url: string;
}

const EMPTY_SNAPSHOT = { data: null as SettingsVersionPayload | null, version: 0 };

let snapshot: { data: SettingsVersionPayload | null; version: number } = EMPTY_SNAPSHOT;

const listeners = new Set<() => void>();

function subscribeServerVersion(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function emit(): void {
  for (const l of listeners) l();
}

/** Invoke after every successful version GET so Settings (nocache) and polling stay in sync app-wide. */
export function publishServerVersion(data: SettingsVersionPayload): void {
  const old = snapshot.data;

  // If we already have a "newer" latest_* version and we receive an older (cached/regressed)
  // payload later, ignore it so the UI never flips backwards.
  // This matters because multiple components can trigger version checks concurrently.
  if (old) {
    const shouldIgnore =
      isPotentiallyRegressing(old.latest_agent_version, data.latest_agent_version) ||
      isPotentiallyRegressing(old.latest_server_release, data.latest_server_release);
    if (shouldIgnore) return;
  }

  snapshot = {
    data,
    version: snapshot.version + 1,
  };
  emit();
}

/** Same object reference until the next publish (for useSyncExternalStore). */
function getServerVersionSnapshotBox(): { data: SettingsVersionPayload | null; version: number } {
  return snapshot;
}

export function useServerVersionPayload(): SettingsVersionPayload | null {
  return useSyncExternalStore(
    subscribeServerVersion,
    () => getServerVersionSnapshotBox().data,
    () => getServerVersionSnapshotBox().data,
  );
}

function parseLooseSemverParts(v: string | null | undefined): number[] | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const noV = s.replace(/^v/i, "");
  const main = noV.split("-", 1)[0];
  const parts = main.split(".");
  if (parts.length === 0) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const m = p.match(/\d+/);
    if (!m) return null;
    nums.push(Number(m[0]));
  }
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

function compareLooseSemver(a: string | null | undefined, b: string | null | undefined): number | null {
  const aa = parseLooseSemverParts(a);
  const bb = parseLooseSemverParts(b);
  if (!aa || !bb) return null;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function isPotentiallyRegressing(oldV: string | null | undefined, newV: string | null | undefined): boolean {
  // Only guard when both sides look like semver-ish versions.
  const cmp = compareLooseSemver(oldV, newV);
  if (cmp == null) return false;
  // "Regressing" means newV < oldV.
  return cmp < 0;
}
