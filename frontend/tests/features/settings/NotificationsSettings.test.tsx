import { buttonByText, click, mountForm, unmountForms } from "@tests/support/formDom";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const api = (() => ({ notificationsStatus: vi.fn(), notificationsTest: vi.fn() }))();
await vi.mock("@/api", () => ({
  api,
  errorText: (e: unknown) => String(e instanceof Error ? e.message : e),
}));

const { NotificationsSettings } = await import("@/features/settings/NotificationsSettings");

const provider = (id: string, enabled: boolean) => ({
  id,
  label: id.toUpperCase(),
  description: `${id} desc`,
  env_keys: [`${id.toUpperCase()}_URL`],
  docs_url: enabled ? "" : `https://example.com/${id}`,
  enabled,
});
const status = (enabledIds: string[]) => ({
  any_enabled: enabledIds.length > 0,
  providers: ["slack", "email", "ntfy"].map((id) => provider(id, enabledIds.includes(id))),
});

const render = (isAdmin = true) =>
  mountForm(withQueryClient(<NotificationsSettings isAdmin={isAdmin} />, createTestQueryClient()));
const text = () => document.body.textContent ?? "";
const buttons = () =>
  [...document.querySelectorAll("button")].map(
    (b) => b.textContent?.trim() || b.getAttribute("aria-label"),
  );

beforeEach(() => vi.clearAllMocks());
afterEach(unmountForms);

describe("alert channels", () => {
  it("leads with the configured channels and tucks the rest away with their setup variables", async () => {
    api.notificationsStatus.mockResolvedValue(status(["slack"]));
    await render();
    expect(text()).toContain("1 of 3 channels set up.");
    expect(document.querySelector("ul")?.textContent).toContain("SLACK");
    const more = document.querySelector("details");
    expect(more?.hasAttribute("open")).toBe(false);
    expect(more?.textContent).toContain("Not set up (2)");
    expect(more?.textContent).toContain("EMAIL_URL");
    expect(text()).toContain("Sends a real message to this channel.");
  });

  it("cannot send a test until a channel is set up, and lists what to do first", async () => {
    api.notificationsStatus.mockResolvedValue(status([]));
    await render();
    expect(text()).toContain("No channel is set up yet. 3 are available.");
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(buttonByText("Send test notification").disabled).toBe(true);
    expect(text()).toContain("Set up a channel first.");
  });

  it("reports each channel's test result without claiming more than was sent", async () => {
    api.notificationsStatus.mockResolvedValue(status(["slack", "email"]));
    api.notificationsTest.mockResolvedValue({
      all_ok: false,
      results: [
        { id: "slack", ok: true, error: null },
        { id: "email", ok: false, error: "SMTP refused" },
      ],
    });
    await render();
    expect(text()).toContain("Sends a real message to all 2 channels.");
    await click(buttonByText("Send test notification"));
    expect(text()).toContain("SLACK: test message sent");
    expect(text()).toContain("EMAIL: failed");
    expect(text()).toContain("SMTP refused");
    expect(text()).not.toContain("delivered");
  });

  it("shows a retry, not an empty list, when the channels cannot be loaded", async () => {
    api.notificationsStatus.mockRejectedValue(new Error("boom"));
    await render();
    expect(text()).toContain("Couldn't load alert channels");
    expect(text()).toContain("boom");
    expect(buttons()).not.toContain("Send test notification");
    api.notificationsStatus.mockResolvedValue(status(["slack"]));
    await click(buttonByText("Try again"));
    expect(text()).toContain("1 of 3 channels set up.");
  });

  it("keeps the last list with a notice when a refresh fails", async () => {
    api.notificationsStatus.mockResolvedValue(status(["slack"]));
    await render();
    api.notificationsStatus.mockRejectedValue(new Error("down"));
    await click(document.querySelector('button[aria-label="Refresh channels"]')!);
    expect(text()).toContain("Couldn't refresh, so this list may be out of date.");
    expect(text()).toContain("1 of 3 channels set up.");
  });

  it("does not ask the server for non-admins", async () => {
    await render(false);
    expect(api.notificationsStatus).not.toHaveBeenCalled();
    expect(text()).toContain("Only admins can see and test alert channels.");
  });
});
