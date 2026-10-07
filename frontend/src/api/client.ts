import { buildApiUrl } from "./serverSettings";
import { notifySessionExpired } from "./sessionExpiry";

export interface PageParams {
  limit?: number;
  offset?: number;
}

export class ApiError extends Error {
  status: number;
  payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/**
 * Human-readable message for any caught value. Prefers the `ApiError`/`Error` message over
 * `String(e)` (which yields noisy `"Error: …"` / `"[object Object]"` text in the UI).
 */
export function errorText(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** `?limit=&offset=` query suffix for list endpoints (omit empty). */
export function limitOffsetQuery(params?: { limit?: number; offset?: number }): string {
  const q = new URLSearchParams();
  if (params?.limit != null) q.set("limit", String(params.limit));
  if (params?.offset != null) q.set("offset", String(params.offset));
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

/** Paths are relative to `apiPrefix` (e.g. `/agents`, `/settings/retention`), not including `/api` twice. */
export function apiUrl(path: string): string {
  return buildApiUrl(path);
}

/** Per-tab CSRF token (`sessionStorage` isolates concurrent logins across browser tabs). */
const CSRF_STORAGE_KEY = "vantyr.dashboard.csrf";

export function setDashboardCsrfToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(CSRF_STORAGE_KEY, token);
    else sessionStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    // Storage disabled — CSRF-protected mutating calls may fail until login succeeds again.
  }
}

export function csrfHeaders(): Record<string, string> {
  try {
    const t = sessionStorage.getItem(CSRF_STORAGE_KEY);
    if (!t) return {};
    return { "X-CSRF-Token": t };
  } catch {
    return {};
  }
}

export async function get<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "GET" }, { includePathInHttpError: true });
}

export async function requestJson<T>(
  path: string,
  init: RequestInit,
  opts?: { includePathInHttpError?: boolean; allowStatuses?: number[] },
): Promise<T> {
  const res = await fetch(apiUrl(path), { ...init, credentials: "include" });
  const ct = res.headers.get("Content-Type") ?? "";

  // Prefer structured errors when possible.
  const allowed = opts?.allowStatuses?.includes(res.status) ?? false;
  if (!res.ok && !allowed) {
    // Global session-expiry recovery: a 401 from any authenticated request means
    // the cookie session is gone. Notify the app so it can demote to signed-out.
    // (Login submits its own 401s, which the app handles inline — skip those.)
    if (res.status === 401 && path !== "/login") {
      setDashboardCsrfToken(null);
      notifySessionExpired();
    }
    if (ct.includes("application/json")) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const suffix = opts?.includePathInHttpError ? ` – ${path}` : "";
      throw new ApiError(body.error ?? `HTTP ${res.status}${suffix}`, res.status, body);
    }
    const text = await res.text().catch(() => "");
    const suffix = opts?.includePathInHttpError ? ` – ${path}` : "";
    throw new ApiError(text.trim() || `HTTP ${res.status}${suffix}`, res.status);
  }

  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new Error(`Expected JSON from ${path}; got ${ct || "unknown type"}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(body),
  });
}

export async function postEmpty<T>(path: string): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { ...csrfHeaders() },
  });
}

export async function postJsonRes<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(body),
  });
}

export async function delJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, {
    method: "DELETE",
    headers: { ...csrfHeaders() },
  });
}
