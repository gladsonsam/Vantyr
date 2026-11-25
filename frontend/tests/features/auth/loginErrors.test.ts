import { describe, expect, it } from "vitest";
import { ApiError } from "@/api";
import { loginFailure } from "@/features/auth/loginErrors";

const apiError = (status: number, payload: object, message = "Request failed") => new ApiError(message, status, payload);

describe("loginFailure", () => {
  it("reveals the code field silently the first time the server asks for a code", () => {
    expect(loginFailure(apiError(401, { totp_required: true, error: "Code required" }), false)).toEqual({ totpRequired: true, message: null });
  });

  it("reports a refused code once one was actually submitted", () => {
    expect(loginFailure(apiError(401, { totp_required: true, error: "Invalid code" }), true)).toEqual({ totpRequired: true, message: "Invalid code" });
  });

  it("keeps the lockout detail: attempts left with the limit, singular and plural", () => {
    expect(loginFailure(apiError(401, { error: "Invalid credentials.", attempts_remaining: 2, max_attempts_per_window: 5 }), false).message)
      .toBe("Invalid credentials. 2 attempts remaining before lockout (limit: 5 wrong passwords / 15 min).");
    expect(loginFailure(apiError(401, { error: "Invalid credentials.", attempts_remaining: 1 }), false).message)
      .toBe("Invalid credentials. 1 attempt remaining before lockout.");
  });

  it("tells a rate-limited person how long to wait, rounded up", () => {
    expect(loginFailure(apiError(429, { error: "Too many attempts.", retry_after_secs: 59.2 }), false).message).toBe("Too many attempts. Retry in about 60s.");
  });

  it("falls back to the server's message, then to a generic one", () => {
    expect(loginFailure(apiError(500, { error: "Server exploded" }), false).message).toBe("Server exploded");
    expect(loginFailure(apiError(500, {}, "Bad gateway"), false).message).toBe("Bad gateway");
  });

  it("says the server could not be reached for anything that is not an API answer", () => {
    expect(loginFailure(new TypeError("fetch failed"), false)).toEqual({ totpRequired: false, message: "Failed to connect to server. Please try again." });
  });
});
