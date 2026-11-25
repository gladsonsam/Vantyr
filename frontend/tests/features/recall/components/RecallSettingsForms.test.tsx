// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { buttonByText, byLabel, click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentRecallSettings } from "@/features/recall/components/AgentRecallSettings";
import { RecallCaptureSettings } from "@/features/recall/components/RecallCaptureSettings";
import type { AgentRecallSettings as Layers, DeviceModuleStatus, RecallSettings } from "@/api/types";

const api = vi.hoisted(() => ({
  agentRecallSettingsGet: vi.fn(),
  agentRecallSettingsPut: vi.fn(),
  agentRecallSettingsDelete: vi.fn(),
  recallSettingsGet: vi.fn(),
  recallSettingsPut: vi.fn(),
  agentModules: vi.fn(),
}));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e instanceof Error ? e.message : e) }));

const FLEET: RecallSettings = { enabled: true, interval_ms: 20_000, hot_interval_ms: 6_000, jpeg_quality: 45, max_dim: 1600, dedup_hamming: 4, keyframe_max_gap_ms: 300_000, ocr: true };
const inheriting = (): Layers => ({ effective: FLEET, override: null, global: FLEET });
const custom = (over: Partial<RecallSettings> = {}): Layers => {
  const mine = { ...FLEET, interval_ms: 60_000, ...over };
  return { effective: mine, override: { ...mine, updated_at: "2026-10-03T00:00:00Z" }, global: FLEET };
};
const device = (recall: { enabled: boolean; available?: boolean } | null, over: Partial<DeviceModuleStatus> = {}): DeviceModuleStatus => ({
  online: true,
  reported_at: "2026-10-03T00:00:00Z",
  authorization_current: true,
  pending: [],
  state: { type: "module_states", schema_version: 1, revision: 1, modules: recall ? [{ module: "recall", available: true, revision: 1, authorization_required: !recall.enabled, ...recall }] : [] },
  ...over,
}) as DeviceModuleStatus;

beforeEach(() => {
  vi.clearAllMocks();
  api.agentModules.mockResolvedValue(device({ enabled: true }));
});
afterEach(unmountForms);

const renderAgent = (props: { isAdmin?: boolean; canOperate?: boolean; id?: string } = {}) =>
  mountForm(withQueryClient(<AgentRecallSettings agentId={props.id ?? "device"} isAdmin={props.isAdmin ?? true} canOperate={props.canOperate} />, createTestQueryClient()));
const buttons = () => [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
const mode = (name: string) => document.querySelector(`[aria-label="Capture settings mode"] [aria-label="${name}"]`) as HTMLButtonElement;

describe("per-device capture settings", () => {
  it("keeps what is saved apart from what the device allows", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(inheriting());
    api.agentModules.mockResolvedValue(device({ enabled: false }));
    await renderAgent();
    expect(document.body.textContent).toContain("Saved: record this screen · fleet defaults");
    expect(document.body.textContent).toContain("This device has Recall off, so nothing is recorded.");
    expect(document.body.textContent).toContain("Only someone at the device can turn it on");
  });

  it("shows fleet defaults read-only, and groups the tuning knobs under More options", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(inheriting());
    await renderAgent();
    expect(mode("Fleet defaults").getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("Interval (seconds)").disabled).toBe(true);
    expect(byLabel("Interval (seconds)").value).toBe("20");
    expect(document.getElementById("recall-dedup")).toBeNull();
    const more = [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("More options"))!;
    expect(more.textContent).toContain("Duplicates 4 · keyframe every 5 min");
    await click(more);
    expect(byLabel("Duplicate threshold (0–64)").disabled).toBe(true);
    expect(byLabel("Keyframe every (minutes)").value).toBe("5");
    expect(buttonByText("Use fleet defaults").disabled).toBe(true);
  });

  it("previews the fleet defaults, not the saved custom values, when switching back", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom());
    await renderAgent();
    expect(document.body.textContent).toContain("custom for this device");
    expect(byLabel("Interval (seconds)").value).toBe("60");
    expect(document.body.textContent).toContain("Fleet default: 20 s");
    await click(mode("Fleet defaults"));
    expect(byLabel("Interval (seconds)").value).toBe("20");
    expect(document.body.textContent).toContain("it follows the fleet defaults again");
    // Going back keeps the custom edits rather than reseeding them.
    await click(mode("Custom"));
    expect(byLabel("Interval (seconds)").value).toBe("60");
  });

  it("saves a custom row only after a change, and says it pins the values", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(inheriting());
    api.agentRecallSettingsPut.mockResolvedValue({ ok: true });
    await renderAgent();
    await click(mode("Custom"));
    expect(document.body.textContent).toContain("later changes to the fleet defaults will not apply to it");
    await typeInto(byLabel("Interval (seconds)"), "45");
    api.agentRecallSettingsGet.mockResolvedValue(custom({ interval_ms: 45_000 }));
    await click(buttonByText("Save"));
    expect(api.agentRecallSettingsPut).toHaveBeenCalledWith("device", { ...FLEET, interval_ms: 45_000 });
    expect(document.body.textContent).toContain("Saved. A connected device is sent it now");
  });

  it("removes the override when going back to fleet defaults", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom());
    api.agentRecallSettingsDelete.mockResolvedValue({ ok: true });
    await renderAgent();
    await click(mode("Fleet defaults"));
    api.agentRecallSettingsGet.mockResolvedValue(inheriting());
    await click(buttonByText("Use fleet defaults"));
    expect(api.agentRecallSettingsDelete).toHaveBeenCalledWith("device");
    expect(document.body.textContent).toContain("Using fleet defaults.");
  });

  it("discards edits and keeps Save off until something changed", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom());
    await renderAgent();
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(byLabel("JPEG quality (1–100)"), "80");
    expect(buttonByText("Save").disabled).toBe(false);
    await click(buttonByText("Discard changes"));
    expect(byLabel("JPEG quality (1–100)").value).toBe("45");
    expect(buttonByText("Save").disabled).toBe(true);
  });

  it("does not offer controls to non-admins and does not ask viewers for the device report", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom());
    await renderAgent({ isAdmin: false, canOperate: false });
    expect(api.agentModules).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("shown to operators");
    expect(document.body.textContent).toContain("Only admins can change capture settings.");
    expect(buttons()).not.toContain("Save");
    expect(byLabel("Interval (seconds)").disabled).toBe(true);
  });

  it("offers a retry when the settings fail to load, instead of an empty form", async () => {
    api.agentRecallSettingsGet.mockRejectedValueOnce(new Error("boom"));
    await renderAgent();
    expect(document.body.textContent).toContain("boom");
    expect(document.querySelector("input")).toBeNull();
    api.agentRecallSettingsGet.mockResolvedValue(inheriting());
    await click(buttonByText("Try again"));
    expect(byLabel("Interval (seconds)")).toBeTruthy();
  });

  it("reports a failed save and keeps the draft", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom());
    api.agentRecallSettingsPut.mockRejectedValue(new Error("not an admin"));
    await renderAgent();
    await typeInto(byLabel("JPEG quality (1–100)"), "80");
    await click(buttonByText("Save"));
    expect(document.body.textContent).toContain("not an admin");
    expect(byLabel("JPEG quality (1–100)").value).toBe("80");
  });
});

describe("capture number fields (shared with the fleet defaults)", () => {
  it("lets 1920 be typed into Max dimension instead of jumping to 320 on the first digit", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom());
    await renderAgent();
    const field = byLabel("Max dimension (px)");
    await typeInto(field, "1");
    expect(field.value).toBe("1");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("Enter 0 for full resolution, or 320 to 7680.");
    // Nothing was committed from the incomplete entry, so there is nothing to save yet.
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(field, "1920");
    expect(field.getAttribute("aria-invalid")).toBe("false");
    expect(buttonByText("Save").disabled).toBe(false);
    await click(buttonByText("Save"));
    expect(api.agentRecallSettingsPut).toHaveBeenCalledWith("device", expect.objectContaining({ max_dim: 1920 }));
  });

  it("returns an invalid entry to the last valid value when the field loses focus", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom());
    await renderAgent();
    const field = byLabel("JPEG quality (1–100)");
    await typeInto(field, "500");
    expect(document.body.textContent).toContain("Leaving the box restores 45.");
    await act(async () => {
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(field.value).toBe("45");
    expect(api.agentRecallSettingsPut).not.toHaveBeenCalled();
  });

  it("keeps seconds and minutes at the server's precision, and allows 0 = full resolution", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom({ interval_ms: 1_500, keyframe_max_gap_ms: 10_000 }));
    api.agentRecallSettingsPut.mockResolvedValue({ ok: true });
    await renderAgent();
    expect(byLabel("Interval (seconds)").value).toBe("1.5");
    await typeInto(byLabel("Max dimension (px)"), "0");
    await click([...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("More options"))!);
    expect(byLabel("Keyframe every (minutes)").value).toBe("0.17");
    await typeInto(byLabel("Duplicate threshold (0–64)"), "65");
    expect(byLabel("Duplicate threshold (0–64)").getAttribute("aria-invalid")).toBe("true");
    await click(buttonByText("Save"));
    expect(api.agentRecallSettingsPut).toHaveBeenCalledWith("device", expect.objectContaining({ max_dim: 0, interval_ms: 1_500, keyframe_max_gap_ms: 10_000, dedup_hamming: 4 }));
  });

  it("locks the tuning fields while recording is off, but leaves Record screen editable", async () => {
    api.agentRecallSettingsGet.mockResolvedValue(custom({ enabled: false }));
    await renderAgent();
    expect(byLabel("Interval (seconds)").disabled).toBe(true);
    expect((document.querySelector('[aria-label="Record screen"]') as HTMLButtonElement).getAttribute("aria-disabled")).not.toBe("true");
    expect(document.body.textContent).toContain("Saved: do not record");
    expect(document.body.textContent).toContain("Capture is off in these settings");
  });
});

describe("device switching", () => {
  it("never carries a draft or a message over to another device", async () => {
    api.agentRecallSettingsGet.mockImplementation(async (id: string) => (id === "a" ? custom() : custom({ jpeg_quality: 70 })));
    api.agentRecallSettingsPut.mockResolvedValue({ ok: true });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = createTestQueryClient();
    const show = (id: string) => act(async () => root.render(withQueryClient(<AgentRecallSettings agentId={id} isAdmin />, client)));
    await show("a");
    await typeInto(byLabel("JPEG quality (1–100)"), "80");
    await click(buttonByText("Save"));
    expect(document.body.textContent).toContain("Saved. A connected device");
    await typeInto(byLabel("JPEG quality (1–100)"), "90");
    await show("b");
    expect(byLabel("JPEG quality (1–100)").value).toBe("70");
    expect(document.body.textContent).not.toContain("Saved. A connected device");
    expect(buttonByText("Save").disabled).toBe(true);
    await act(async () => root.unmount());
    host.remove();
  });
});

describe("fleet-default capture settings still behave as before", () => {
  it("keeps the module note, shows every field, and saves the edited row", async () => {
    api.recallSettingsGet.mockResolvedValue(FLEET);
    api.recallSettingsPut.mockResolvedValue({ ...FLEET, jpeg_quality: 70 });
    await mountForm(withQueryClient(<RecallCaptureSettings isAdmin />, createTestQueryClient()));
    expect(document.body.textContent).toContain("Also needs the device’s Recall module.");
    expect(document.body.textContent).not.toContain("Fleet default:");
    await typeInto(byLabel("JPEG quality (1–100)"), "70");
    await click(buttonByText("Save capture settings"));
    expect(api.recallSettingsPut).toHaveBeenCalledWith({ ...FLEET, jpeg_quality: 70 });
    expect(document.body.textContent).toContain("Capture settings saved and pushed to connected agents.");
  });

  it("is read-only for non-admins", async () => {
    api.recallSettingsGet.mockResolvedValue(FLEET);
    await mountForm(withQueryClient(<RecallCaptureSettings isAdmin={false} />, createTestQueryClient()));
    expect(byLabel("Interval (seconds)").disabled).toBe(true);
    expect(document.body.textContent).toContain("Admins only.");
  });
});
