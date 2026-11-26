import { describe, expect, it } from "bun:test";
import { describeScriptResult } from "@/features/agent-detail/lib/scriptResult";

describe("describeScriptResult", () => {
  it("calls a run successful only when the device said ok", () => {
    expect(describeScriptResult({ ok: true, exit_code: 0, stdout: "hi" })).toMatchObject({
      tone: "ok",
      headline: "Finished · exit code 0",
      stdout: "hi",
    });
    expect(describeScriptResult({ ok: true })).toMatchObject({ tone: "ok", headline: "Finished" });
  });

  it("reports a non-zero exit as failed even if the reply says ok", () => {
    expect(describeScriptResult({ ok: true, exit_code: 3 }).tone).toBe("failed");
    expect(describeScriptResult({ ok: false, exit_code: 1, stderr: "nope" })).toMatchObject({
      tone: "failed",
      headline: "Failed · exit code 1",
      stderr: "nope",
    });
  });

  it("keeps the device's error when the script did not run to the end", () => {
    expect(
      describeScriptResult({ ok: false, error: "Timed out waiting for script result." }),
    ).toMatchObject({
      tone: "error",
      headline: "Didn’t finish",
      error: "Timed out waiting for script result.",
    });
    expect(describeScriptResult({})).toMatchObject({
      tone: "error",
      stdout: "",
      stderr: "",
      error: null,
    });
  });
});
