import { describe, expect, it } from "vitest";
import type { FieldErrors } from "react-hook-form";
import { firstErrorMessage } from "@/components/common/form/errors";

describe("firstErrorMessage", () => {
  it("is null when there are no errors", () => {
    expect(firstErrorMessage({})).toBeNull();
  });

  it("returns the first field's message", () => {
    const errors = { a: { type: "custom", message: "A is required" }, b: { type: "custom", message: "B is required" } } as FieldErrors;
    expect(firstErrorMessage(errors)).toBe("A is required");
  });

  it("looks inside nested and array errors and skips entries without a message", () => {
    const errors = { rows: [undefined, { start: { type: "custom", message: "Bad start" } }] } as unknown as FieldErrors;
    expect(firstErrorMessage(errors)).toBe("Bad start");
    expect(firstErrorMessage({ x: { type: "custom" } } as FieldErrors)).toBeNull();
  });
});
