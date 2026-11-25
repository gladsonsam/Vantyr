import { isApiError } from "@/api";

/** What a failed sign-in means for the form. */
export interface LoginFailure {
  /** The server wants an authenticator (or recovery) code with the password. */
  totpRequired: boolean;
  /** What to tell the person; null when the code field is simply being revealed. */
  message: string | null;
}

interface LoginErrorPayload {
  error?: string;
  attempts_remaining?: number;
  max_attempts_per_window?: number;
  retry_after_secs?: number;
  totp_required?: boolean;
}

/**
 * Turns a failed sign-in into what the form shows. A first "code required" answer reveals the
 * code field silently; it only becomes an error once a code was actually submitted and refused.
 * Lockout details (attempts left, retry delay) are kept so people know when to stop guessing.
 */
export function loginFailure(err: unknown, codeSubmitted: boolean): LoginFailure {
  if (!isApiError(err)) return { totpRequired: false, message: "Failed to connect to server. Please try again." };

  const payload = (err.payload ?? {}) as LoginErrorPayload;
  const base = payload.error ?? err.message ?? "Login failed";
  if (payload.totp_required) return { totpRequired: true, message: codeSubmitted ? base : null };
  if (err.status === 429 && typeof payload.retry_after_secs === "number") {
    return { totpRequired: false, message: `${base} Retry in about ${Math.ceil(payload.retry_after_secs)}s.` };
  }
  if (err.status === 401 && typeof payload.attempts_remaining === "number") {
    const n = payload.attempts_remaining;
    const max = payload.max_attempts_per_window;
    const limit = typeof max === "number" ? ` (limit: ${max} wrong passwords / 15 min)` : "";
    return { totpRequired: false, message: `${base} ${n} attempt${n === 1 ? "" : "s"} remaining before lockout${limit}.` };
  }
  return { totpRequired: false, message: base };
}
