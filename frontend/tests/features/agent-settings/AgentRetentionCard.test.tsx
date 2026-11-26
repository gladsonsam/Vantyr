import {
  buttonByText,
  byLabel,
  click,
  mountForm,
  typeInto,
  unmountForms,
} from "@tests/support/formDom";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const api = (() => ({
  retentionAgentGet: vi.fn(),
  retentionAgentPut: vi.fn(),
  retentionAgentDelete: vi.fn(),
}))();
await vi.mock("@/api", () => ({
  api,
  errorText: (e: unknown) => String(e instanceof Error ? e.message : e),
}));

const { AgentRetentionCard } = await import("@/features/agent-settings/AgentRetentionCard");

const GLOBAL = { keylog_days: 14, window_days: 30, url_days: null };
const inherited = { global: GLOBAL, override: null };
const overridden = { global: GLOBAL, override: { keylog_days: 0, window_days: null, url_days: 7 } };

beforeEach(() => vi.clearAllMocks());
afterEach(unmountForms);

const render = (isAdmin = true, id = "device") =>
  mountForm(
    withQueryClient(<AgentRetentionCard agentId={id} isAdmin={isAdmin} />, createTestQueryClient()),
  );
const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("agent retention", () => {
  it("shows inherited defaults as placeholders and states what each value means", async () => {
    api.retentionAgentGet.mockResolvedValue(inherited);
    await render();
    expect(document.body.textContent).toContain("Using the default retention");
    expect(byLabel("Keystrokes").placeholder).toBe("Default: 14 days");
    expect(byLabel("Websites").placeholder).toBe("Default: forever");
    expect(document.body.textContent).toContain("Uses the default: keeps 14 days.");
    expect(buttons()).not.toContain("Use defaults for all");
    expect(buttonByText("Save").disabled).toBe(true);
  });

  it("shows saved overrides, with 0 as 'forever' and blank as inherited", async () => {
    api.retentionAgentGet.mockResolvedValue(overridden);
    await render();
    expect(document.body.textContent).toContain("2 of 3 set for this device");
    expect(byLabel("Keystrokes").value).toBe("0");
    expect(document.body.textContent).toContain("Keeps forever, instead of the default (14 days).");
    expect(byLabel("App windows").value).toBe("");
    expect(byLabel("Websites").value).toBe("7");
    expect(buttons()).toContain("Use defaults for all");
  });

  it("sends exactly the typed meaning: blank = inherit (null), 0 = unlimited (0)", async () => {
    api.retentionAgentGet.mockResolvedValue(inherited);
    api.retentionAgentPut.mockResolvedValue(overridden);
    await render();
    await typeInto(byLabel("Keystrokes"), "0");
    await typeInto(byLabel("Websites"), "7");
    expect(buttonByText("Save").disabled).toBe(false);
    await click(buttonByText("Save"));
    expect(api.retentionAgentPut).toHaveBeenCalledWith("device", {
      keylog_days: 0,
      window_days: null,
      url_days: 7,
    });
    expect(document.body.textContent).toContain("Saved.");
  });

  it("blocks invalid values with a reason and sends nothing", async () => {
    api.retentionAgentGet.mockResolvedValue(inherited);
    await render();
    await typeInto(byLabel("App windows"), "36501");
    expect(document.body.textContent).toContain("Use 0 for unlimited, 1–36500");
    expect(byLabel("App windows").getAttribute("aria-invalid")).toBe("true");
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(byLabel("App windows"), "1.5");
    expect(document.body.textContent).toContain("Enter a whole number of days");
    expect(api.retentionAgentPut).not.toHaveBeenCalled();
  });

  it("discards edits back to what is saved, and resets one field to the default", async () => {
    api.retentionAgentGet.mockResolvedValue(overridden);
    await render();
    await typeInto(byLabel("Websites"), "30");
    expect(buttons()).toContain("Discard changes");
    expect(buttons()).not.toContain("Use defaults for all");
    await click(buttonByText("Discard changes"));
    expect(byLabel("Websites").value).toBe("7");
    await click(document.querySelector('button[aria-label="Use the default for Websites"]')!);
    expect(byLabel("Websites").value).toBe("");
    expect(buttonByText("Save").disabled).toBe(false);
  });

  it("clears all overrides through the delete endpoint", async () => {
    api.retentionAgentGet.mockResolvedValue(overridden);
    api.retentionAgentDelete.mockResolvedValue(inherited);
    await render();
    await click(buttonByText("Use defaults for all"));
    expect(api.retentionAgentDelete).toHaveBeenCalledWith("device");
    expect(document.body.textContent).toContain("Using the defaults.");
    expect(byLabel("Keystrokes").value).toBe("");
  });

  it("does not show an empty form when the load failed (Save would clear the overrides)", async () => {
    api.retentionAgentGet.mockRejectedValue(new Error("server down"));
    await render();
    expect(document.body.textContent).toContain("server down");
    expect(document.querySelector("input")).toBeNull();
    expect(buttons()).not.toContain("Save");
    api.retentionAgentGet.mockResolvedValue(inherited);
    await click(buttonByText("Try again"));
    expect(byLabel("Keystrokes")).toBeTruthy();
  });

  it("is read-only for non-admins", async () => {
    api.retentionAgentGet.mockResolvedValue(overridden);
    await render(false);
    expect(byLabel("Keystrokes").disabled).toBe(true);
    expect(buttons()).not.toContain("Save");
    expect(document.body.textContent).toContain("Only admins can change retention.");
  });

  it("reports a failed save and keeps the typed values", async () => {
    api.retentionAgentGet.mockResolvedValue(inherited);
    api.retentionAgentPut.mockRejectedValue(new Error("forbidden"));
    await render();
    await typeInto(byLabel("Keystrokes"), "5");
    await click(buttonByText("Save"));
    expect(document.body.textContent).toContain("forbidden");
    expect(byLabel("Keystrokes").value).toBe("5");
  });
});
