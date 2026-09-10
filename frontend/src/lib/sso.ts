import { apiUrl } from "./api";

/**
 * SSO auto-redirect helpers (opt-in via server `OIDC_AUTO_LOGIN=1`).
 *
 * When enabled, an unauthenticated SPA skips the login screen and goes straight
 * to `GET /api/auth/oidc/login`. If the IdP session is still valid (the normal
 * "session expired but I'm still signed in at Authentik" case) the IdP bounces
 * straight back with a fresh session — no click needed.
 *
 * Guards against redirect loops / logout traps:
 * - `?local=1` (or `?noauto=1`) in the URL forces the local login screen.
 * - One auto-attempt per tab session (`sessionStorage`): if SSO fails and drops
 *   us back unauthenticated, we show the login screen instead of looping.
 * - Explicit logout marks the tab manual so "Sign out" doesn't instantly sign
 *   you back in.
 */

const AUTO_ATTEMPT_KEY = "vantyr.sso.auto.attempted";
const MANUAL_KEY = "vantyr.sso.manual";

function storageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage disabled — guards degrade to URL-param only */
  }
}

function storageRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** True when the current URL explicitly asks for the local login screen. */
export function ssoAutoRedirectOptedOut(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search);
    return q.has("local") || q.has("noauto") || q.get("sso") === "manual";
  } catch {
    return false;
  }
}

/** True when this tab already tried one automatic SSO hop (loop guard). */
export function ssoAutoAttempted(): boolean {
  return storageGet(AUTO_ATTEMPT_KEY) === "1";
}

function markSsoAutoAttempted(): void {
  storageSet(AUTO_ATTEMPT_KEY, "1");
}

/** Call on explicit logout so the login screen stays put instead of re-hopping to SSO. */
export function markSsoManual(): void {
  storageSet(MANUAL_KEY, "1");
}

/** Call on successful authentication so the next expiry can auto-hop again. */
export function clearSsoGuards(): void {
  storageRemove(MANUAL_KEY);
  storageRemove(AUTO_ATTEMPT_KEY);
}

export function ssoManualLogout(): boolean {
  return storageGet(MANUAL_KEY) === "1";
}

/** Whether an automatic SSO hop is allowed right now (pure; no side effects). */
export function canAutoRedirectToSso(): boolean {
  if (ssoAutoRedirectOptedOut()) return false;
  if (ssoManualLogout()) return false;
  if (ssoAutoAttempted()) return false;
  return true;
}

/**
 * Navigate the whole tab to the OIDC login (full-page redirect so auth cookies
 * flow). Records the attempt first so a failed round-trip can't loop forever.
 */
export function redirectToSso(returnTo?: string): void {
  markSsoAutoAttempted();
  const fallback =
    typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
  let target = (returnTo ?? fallback).trim();
  // Never echo the opt-out params back into the post-login landing page.
  try {
    const u = new URL(target, "http://x");
    u.searchParams.delete("local");
    u.searchParams.delete("noauto");
    target = u.pathname + u.search + u.hash;
  } catch {
    /* keep raw target; server sanitizes anyway */
  }
  window.location.href = apiUrl(`/auth/oidc/login?return_to=${encodeURIComponent(target)}`);
}
