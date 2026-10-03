import { describe, it, expect } from "vitest";
import { ApiError, isApiError, errorText, historyRangeQuery } from "./api";

describe("ApiError", () => {
  it("carries message, status, and payload", () => {
    const err = new ApiError("nope", 404, { error: "not found" });
    expect(err.message).toBe("nope");
    expect(err.status).toBe(404);
    expect(err.payload).toEqual({ error: "not found" });
    expect(err.name).toBe("ApiError");
    expect(err).toBeInstanceOf(Error);
  });

  it("isApiError narrows only genuine ApiError instances", () => {
    expect(isApiError(new ApiError("x", 500))).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError({ status: 404, message: "x" })).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
  });
});

describe("errorText", () => {
  it("prefers ApiError/Error messages over String(e)", () => {
    expect(errorText(new ApiError("rate limited", 429))).toBe("rate limited");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain string")).toBe("plain string");
    expect(errorText({ weird: true })).toBe("[object Object]");
  });
});

describe("Recall query encoding", () => {
  it("preserves display zero and safely encodes continuation filters", () => {
    const params = new URLSearchParams(historyRangeQuery({ monitor: 0, cursor: "opaque+/=", scope: "retained", sort: "newest", limit: 100 }));
    expect(params.get("monitor")).toBe("0");
    expect(params.get("cursor")).toBe("opaque+/=");
    expect(params.get("scope")).toBe("retained");
    expect(params.get("sort")).toBe("newest");
    expect(params.has("from")).toBe(false);
  });
});
