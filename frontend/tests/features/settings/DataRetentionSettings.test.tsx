// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { buttonByText, byLabel, click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { DataRetentionSettings } from "@/features/settings/DataRetentionSettings";
import { useRetentionSettings } from "@/features/settings/hooks/useRetentionSettings";

const api = vi.hoisted(() => ({ retentionGlobalGet: vi.fn(), retentionGlobalPut: vi.fn() }));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e instanceof Error ? e.message : e) }));

const saved = { keylog_days: 14, window_days: null, url_days: 30 };

function Harness({ isAdmin }: { isAdmin: boolean }) {
  const form = useRetentionSettings(isAdmin);
  return <DataRetentionSettings form={form} isAdmin={isAdmin} />;
}

const render = (isAdmin = true) => mountForm(withQueryClient(<Harness isAdmin={isAdmin} />, createTestQueryClient()));
const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
const text = () => document.body.textContent ?? "";

beforeEach(() => vi.clearAllMocks());
afterEach(unmountForms);

describe("global data retention", () => {
  it("shows no form when the limits could not be loaded, so Save cannot erase them", async () => {
    api.retentionGlobalGet.mockRejectedValue(new Error("boom"));
    await render();
    expect(text()).toContain("Couldn't load data retention. boom");
    expect(buttons()).toContain("Try again");
    expect(buttons()).not.toContain("Save");
    expect(document.querySelectorAll("input")).toHaveLength(0);

    api.retentionGlobalGet.mockResolvedValue(saved);
    await click(buttonByText("Try again"));
    expect(byLabel("Keystrokes").value).toBe("14");
  });

  it("shows the saved limits with forever as 0 and says what each value does", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    await render();
    expect(text()).toContain("2 of 3 kinds of data deleted after a set time");
    expect(byLabel("Keystrokes").value).toBe("14");
    expect(byLabel("App windows and activity").value).toBe("0");
    expect(byLabel("Websites").value).toBe("30");
    expect(text()).toContain("Deletes data older than 14 days.");
    expect(text()).toContain("Keeps this data forever.");
    expect(buttonByText("Save").disabled).toBe(true);
    expect(buttons()).not.toContain("Discard changes");
  });

  it("treats blank and 0 as the same saved meaning, so neither is a change", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    await render();
    await typeInto(byLabel("App windows and activity"), "");
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(byLabel("App windows and activity"), "0");
    expect(buttonByText("Save").disabled).toBe(true);
  });

  it("blocks values it cannot use instead of clamping them", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    await render();
    await typeInto(byLabel("Websites"), "36501");
    expect(text()).toContain("Use 0 for unlimited, or a number from 1 to 36500.");
    expect(byLabel("Websites").getAttribute("aria-invalid")).toBe("true");
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(byLabel("Websites"), "-3");
    expect(buttonByText("Save").disabled).toBe(true);
    expect(api.retentionGlobalPut).not.toHaveBeenCalled();
  });

  it("saves a longer limit and forever as null without a warning, then says it saved", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    api.retentionGlobalPut.mockResolvedValue({ keylog_days: 60, window_days: null, url_days: null });
    await render();
    await typeInto(byLabel("Keystrokes"), "60");
    await typeInto(byLabel("Websites"), "0");
    expect(text()).toContain("Unsaved changes");
    expect(text()).toContain("Saved: 14 days.");
    await click(buttonByText("Save"));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.retentionGlobalPut).toHaveBeenCalledWith({ keylog_days: 60, window_days: null, url_days: null });
    expect(text()).toContain("Saved. Data older than these limits is deleted automatically.");
    expect(buttonByText("Save").disabled).toBe(true);
    expect(byLabel("Websites").value).toBe("0");
  });

  it("says nothing is deleted when every limit is forever", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    api.retentionGlobalPut.mockResolvedValue({ keylog_days: null, window_days: null, url_days: null });
    await render();
    await typeInto(byLabel("Keystrokes"), "");
    await typeInto(byLabel("Websites"), "0");
    await click(buttonByText("Save"));
    expect(api.retentionGlobalPut).toHaveBeenCalledWith({ keylog_days: null, window_days: null, url_days: null });
    expect(text()).toContain("Saved. Nothing is deleted automatically.");
  });

  it("asks before a shorter limit, naming what will be deleted, and sends nothing on cancel", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    api.retentionGlobalPut.mockResolvedValue({ keylog_days: 7, window_days: 90, url_days: 30 });
    await render();
    await typeInto(byLabel("Keystrokes"), "7");
    await typeInto(byLabel("App windows and activity"), "90");
    await click(buttonByText("Save"));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("cannot be recovered");
    expect(dialog?.textContent).toContain("Keystrokes: older than 7 days (now 14 days)");
    expect(dialog?.textContent).toContain("App windows and activity: older than 90 days (now forever)");
    expect(dialog?.textContent).not.toContain("Websites:");
    expect(api.retentionGlobalPut).not.toHaveBeenCalled();

    await click(buttonByText("Keep current limits"));
    expect(api.retentionGlobalPut).not.toHaveBeenCalled();
    expect(byLabel("Keystrokes").value).toBe("7");

    await click(buttonByText("Save"));
    await click(buttonByText("Save and delete older data"));
    expect(api.retentionGlobalPut).toHaveBeenCalledWith({ keylog_days: 7, window_days: 90, url_days: 30 });
    expect(text()).toContain("Saved.");
  });

  it("keeps the edits and reports a refused save, and discard restores the saved limits", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    api.retentionGlobalPut.mockRejectedValue(new Error("Server said no"));
    await render();
    await typeInto(byLabel("Keystrokes"), "30");
    await click(buttonByText("Save"));
    expect(text()).toContain("Not saved. Server said no");
    expect(text()).not.toContain("Saved. ");
    expect(byLabel("Keystrokes").value).toBe("30");
    expect(buttonByText("Save").disabled).toBe(false);

    await click(buttonByText("Discard changes"));
    expect(byLabel("Keystrokes").value).toBe("14");
    expect(text()).not.toContain("Not saved.");
    expect(buttons()).not.toContain("Discard changes");
  });

  it("is read-only for people who are not admins", async () => {
    api.retentionGlobalGet.mockResolvedValue(saved);
    await render(false);
    expect(byLabel("Keystrokes").disabled).toBe(true);
    expect(buttons()).not.toContain("Save");
    expect(text()).toContain("Only admins can change retention.");
  });
});
