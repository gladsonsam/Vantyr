import { buttonByText, click, mountForm, unmountForms } from "@tests/support/formDom";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { UrlCategorizationStatus } from "@/features/settings/hooks/useUrlCategorization";

const api = (() => ({
  urlCategorizationStatusGet: vi.fn(),
  urlCategorizationSettingsPut: vi.fn(),
  urlCategorizationUpdateNow: vi.fn(),
}))();
await vi.mock("@/api", () => ({ api }));

const { UrlCategorizationSettings } = await import("@/features/settings/UrlCategorizationSettings");
const { useUrlCategorization } = await import("@/features/settings/hooks/useUrlCategorization");

const ready: UrlCategorizationStatus = {
  settings: {
    enabled: true,
    auto_update: true,
    source_url: "https://example.com/list.tar.gz",
    last_update_at: "2026-01-02T03:04:05Z",
    last_update_error: null,
  },
  active_release: { sha256: "abc123def456" },
  counts: { categories: 84, domains: 138000, urls: 42000 },
  job: null,
};

function Harness({ isAdmin = true }: { isAdmin?: boolean }) {
  const urlCat = useUrlCategorization(isAdmin);
  return <UrlCategorizationSettings isAdmin={isAdmin} urlCat={urlCat} />;
}
const render = (isAdmin = true) =>
  mountForm(withQueryClient(<Harness isAdmin={isAdmin} />, createTestQueryClient()));
const text = () => document.body.textContent ?? "";
const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
const switches = () => [...document.querySelectorAll('[role="switch"]')] as HTMLElement[];

beforeEach(() => {
  vi.clearAllMocks();
  api.urlCategorizationSettingsPut.mockResolvedValue({});
  api.urlCategorizationUpdateNow.mockResolvedValue({});
});
afterEach(unmountForms);

describe("URL categorization settings", () => {
  it("says what it does and gives non-admins no controls", async () => {
    await render(false);
    expect(text()).toContain("Sorts the websites devices visit into categories");
    expect(text()).toContain("Only admins can view or change these settings.");
    expect(switches()).toHaveLength(0);
    expect(api.urlCategorizationStatusGet).not.toHaveBeenCalled();
  });

  it("shows no switches when the settings could not load, so defaults are not read as the real state", async () => {
    api.urlCategorizationStatusGet.mockRejectedValueOnce(new Error("boom"));
    await render();
    expect(text()).toContain("Couldn't load URL categorization settings. boom");
    expect(switches()).toHaveLength(0);
    api.urlCategorizationStatusGet.mockResolvedValue(ready);
    await click(buttonByText("Try again"));
    expect(switches()).toHaveLength(2);
  });

  it("summarizes the lists: when they were updated, how much they hold, with the checksum behind a disclosure", async () => {
    api.urlCategorizationStatusGet.mockResolvedValue(ready);
    await render();
    expect(text()).toContain("Lists updated");
    expect(text()).toContain("84 categories");
    expect(text()).toContain("138,000 domains");
    expect(document.querySelector("details")?.textContent).toContain("abc123def456");
  });

  it("says a failed update failed, keeping the last good time", async () => {
    api.urlCategorizationStatusGet.mockResolvedValue({
      ...ready,
      settings: { ...ready.settings, last_update_error: "tls handshake failed" },
    });
    await render();
    expect(text()).toContain("The last list update failed.");
    expect(text()).toContain("tls handshake failed");
    expect(text()).toContain("Last successful update:");
  });

  it("says no lists exist yet and ties the actions to turning categorization on", async () => {
    api.urlCategorizationStatusGet.mockResolvedValue({
      ...ready,
      settings: { ...ready.settings, enabled: false, last_update_at: null },
      active_release: { sha256: null },
    });
    await render();
    expect(text()).toContain("No lists downloaded yet.");
    expect(text()).toContain("Turn on categorization to download lists and manage overrides.");
    expect(buttonByText("Download lists now").disabled).toBe(true);
    expect(buttonByText("Manage overrides").disabled).toBe(true);
    expect(
      switches()[1].getAttribute("aria-disabled") === "true" ||
        switches()[1].hasAttribute("data-disabled"),
    ).toBe(true);
  });

  it("sends only the toggled setting with the rest as saved", async () => {
    api.urlCategorizationStatusGet.mockResolvedValue(ready);
    await render();
    await click(switches()[0]);
    expect(api.urlCategorizationSettingsPut).toHaveBeenCalledWith({
      enabled: false,
      auto_update: true,
      source_url: "https://example.com/list.tar.gz",
    });
  });

  it("reports a refused change and keeps showing the saved state", async () => {
    api.urlCategorizationStatusGet.mockResolvedValue(ready);
    api.urlCategorizationSettingsPut.mockRejectedValue(new Error("not allowed"));
    await render();
    await click(switches()[0]);
    expect(text()).toContain("Not changed. not allowed");
    expect(switches()[0].getAttribute("aria-checked")).toBe("true");
  });

  it("shows progress while a download runs and blocks a second download", async () => {
    api.urlCategorizationStatusGet.mockResolvedValue({
      ...ready,
      job: {
        state: "downloading",
        started_at: null,
        updated_at: "",
        bytes_total: 4 * 1024 * 1024,
        bytes_done: 1024 * 1024,
        message: null,
      },
    });
    await render();
    expect(text()).toContain("Downloading the lists…");
    expect(text()).toContain("1 of 4 MB");
    expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "25",
    );
    expect(buttonByText("Download lists now").disabled).toBe(true);
  });

  it("confirms a requested download and keeps the status when a refresh fails", async () => {
    api.urlCategorizationStatusGet.mockResolvedValue(ready);
    await render();
    await click(buttonByText("Download lists now"));
    expect(api.urlCategorizationUpdateNow).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Download requested.");
    api.urlCategorizationStatusGet.mockRejectedValue(new Error("offline"));
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Refresh status"]')!);
    expect(text()).toContain(
      "Couldn't refresh the status. What's shown may be out of date. offline",
    );
    expect(text()).toContain("84 categories");
    expect(buttons()).toContain("Try again");
  });
});
