export type ActivityUrlStateV1 = {
  v: 1;
  q?: string;
  alerts?: boolean;
  app?: string | null;
  /** YYYY-MM-DD (local day keys used by ActivityTimeline) */
  from?: string | null;
  to?: string | null;
};

function isTabKeyLike(tab: string | null): boolean {
  return (
    tab === "live" ||
    /** Legacy deep links; agent detail route normalizes this to `live`. */
    tab === "screen" ||
    tab === "activity" ||
    tab === "specs" ||
    tab === "software" ||
    tab === "scripts" ||
    tab === "logs" ||
    tab === "analytics" ||
    tab === "keys" ||
    tab === "windows" ||
    tab === "urls" ||
    tab === "alerts" ||
    tab === "files" ||
    tab === "control" ||
    tab === "terminal" ||
    tab === "settings"
  );
}

function utf8ToBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // base64url (no padding) — URL-safe and compact enough for bookmarks.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToUtf8(b64url: string): string {
  const pad = b64url.length % 4 === 0 ? "" : "=".repeat(4 - (b64url.length % 4));
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeActivityState(state: ActivityUrlStateV1): string {
  return utf8ToBase64Url(JSON.stringify(state));
}

export function decodeActivityState(raw: string | null): ActivityUrlStateV1 | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const json = base64UrlToUtf8(s);
    const v = JSON.parse(json) as ActivityUrlStateV1;
    if (!v || v.v !== 1) return null;
    return v;
  } catch {
    return null;
  }
}

export function applyActivityStateToSearchParams(
  prev: URLSearchParams,
  state: ActivityUrlStateV1 | null,
): URLSearchParams {
  const next = new URLSearchParams(prev);

  // Preserve unrelated params (e.g. `at=` highlight), but always force activity tab when applying activity state.
  if (state) {
    next.set("tab", "activity");
    next.set("activity", encodeActivityState(state));
  } else {
    next.delete("activity");
  }

  // If caller navigates to activity without an explicit tab, keep existing tab unless we set activity.
  // (When state is null, we do not touch tab.)
  return next;
}

export function readActivityStateFromSearchParams(params: URLSearchParams): ActivityUrlStateV1 | null {
  return decodeActivityState(params.get("activity"));
}

export function pruneSearchParamsForShare(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  const tab = params.get("tab");
  if (tab && isTabKeyLike(tab)) next.set("tab", tab);
  const activity = params.get("activity");
  if (activity) next.set("activity", activity);
  const at = params.get("at");
  if (at) next.set("at", at);
  return next;
}
