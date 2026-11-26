import { describe, expect, it } from "bun:test";
import { terminalStatus } from "@/features/remote/lib/terminalStatus";

describe("terminalStatus", () => {
  it("offers no automatic action before the first start", () => {
    expect(terminalStatus("idle")).toMatchObject({ text: "Not started", action: null });
  });

  it("lets a live or pending session be ended, and nothing else", () => {
    expect(terminalStatus("live").action).toEqual({ label: "End session", kind: "stop" });
    expect(terminalStatus("connecting").action).toEqual({ label: "Cancel", kind: "stop" });
  });

  it("starts a new shell only from an explicit button after the session is over", () => {
    expect(terminalStatus("ended").action).toEqual({ label: "New session", kind: "start" });
    expect(terminalStatus("dropped")).toMatchObject({
      tone: "warn",
      action: { label: "Reconnect", kind: "start" },
    });
    const refused = terminalStatus("refused");
    expect(refused.tone).toBe("warn");
    expect(refused.text).toContain("allowed on the device");
    expect(refused.action?.label).toBe("Retry");
  });
});
