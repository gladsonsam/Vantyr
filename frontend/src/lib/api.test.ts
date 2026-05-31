import { describe, it, expect } from "vitest";
import { ApiError, isApiError } from "./api";

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
