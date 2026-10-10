import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { isDefinitiveFailure, logPollInterval, logRetry } from "@/features/agent-detail/lib/logPolling";

describe("log polling", () => {
  it("treats authorisation 4xx as definitive but not timeouts, rate limits or network errors", () => {
    expect(isDefinitiveFailure(new ApiError("nope", 403))).toBe(true);
    expect(isDefinitiveFailure(new ApiError("gone", 404))).toBe(true);
    expect(isDefinitiveFailure(new ApiError("slow", 408))).toBe(false);
    expect(isDefinitiveFailure(new ApiError("many", 429))).toBe(false);
    expect(isDefinitiveFailure(new ApiError("boom", 502))).toBe(false);
    expect(isDefinitiveFailure(new Error("network"))).toBe(false);
  });

  it("stops polling after a definitive failure and resumes once the error clears", () => {
    expect(logPollInterval(true, null)).toBe(2000);
    expect(logPollInterval(true, new Error("blip"))).toBe(2000);
    expect(logPollInterval(true, new ApiError("nope", 403))).toBe(false);
    expect(logPollInterval(false, null)).toBe(false);
  });

  it("does not retry definitive failures", () => {
    expect(logRetry(0, new ApiError("nope", 403))).toBe(false);
    expect(logRetry(0, new Error("blip"))).toBe(true);
    expect(logRetry(2, new Error("blip"))).toBe(false);
  });
});
