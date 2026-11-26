import {
  buttonByText,
  byLabel,
  click,
  fieldErrors,
  mountForm,
  typeInto,
  unmountForms,
} from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";

import type { UrlCategorizationStatus } from "@/features/settings/hooks/useUrlCategorization";

const override = {
  id: 1,
  kind: "domain" as const,
  value: "github.com",
  category_key: "games",
  category_label: "Games",
  note: "Work tool",
  created_at: "2026-01-02T03:04:05Z",
};
const api = (() => ({
  urlCategorizationOverridesList: vi.fn(async () => ({ rows: [] as unknown[] })),
  urlCategorizationCategoriesGet: vi.fn(async () => ({
    categories: [{ key: "games", label: "Games", enabled: true, description: "" }],
  })),
  urlCategorizationOverridesDelete: vi.fn(async () => ({})),
  urlCategorizationRecalcUrlVisits: vi.fn(async () => ({ enqueued: 500 })),
  urlCategorizationRecalcUrlSessions: vi.fn(async () => ({ updated: 1 })),
}))();
await vi.mock("@/api", () => ({ api }));

const { UrlOverridesDialog } = await import("@/features/settings/components/UrlOverridesDialog");
const { UrlSourceForm } = await import("@/features/settings/components/UrlSourceForm");

afterEach(() => {
  unmountForms();
  vi.resetAllMocks();
  api.urlCategorizationOverridesList.mockResolvedValue({ rows: [] });
  api.urlCategorizationCategoriesGet.mockResolvedValue({
    categories: [{ key: "games", label: "Games", enabled: true, description: "" }],
  });
  api.urlCategorizationOverridesDelete.mockResolvedValue({});
  api.urlCategorizationRecalcUrlVisits.mockResolvedValue({ enqueued: 500 });
  api.urlCategorizationRecalcUrlSessions.mockResolvedValue({ updated: 1 });
});

const status: UrlCategorizationStatus = {
  settings: {
    enabled: true,
    auto_update: true,
    source_url: "https://example.com/list.tar.gz",
    last_update_at: null,
    last_update_error: null,
  },
  active_release: { sha256: null },
  counts: { categories: 0, domains: 0, urls: 0 },
  job: null,
};

const text = () => document.body.textContent ?? "";
const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("UrlSourceForm", () => {
  it("starts from the server's source URL and saves the typed one", async () => {
    const onSave = vi.fn();
    await mountForm(<UrlSourceForm status={status} version={1} saving={false} onSave={onSave} />);
    expect(byLabel("List source").value).toBe("https://example.com/list.tar.gz");
    await typeInto(byLabel("List source"), " https://mirror.local/ut1.tar.gz ");
    await click(buttonByText("Save source URL"));
    expect(onSave).toHaveBeenCalledWith("https://mirror.local/ut1.tar.gz");
  });

  it("keeps Save disabled until the address changes and says the change is not saved yet", async () => {
    await mountForm(<UrlSourceForm status={status} version={1} saving={false} onSave={vi.fn()} />);
    expect(buttonByText("Save source URL").disabled).toBe(true);
    await typeInto(byLabel("List source"), "https://mirror.local/ut1.tar.gz");
    expect(buttonByText("Save source URL").disabled).toBe(false);
    expect(text()).toContain("Not saved yet.");
  });

  it("shows 'source_url is required' and does not save a blank URL", async () => {
    const onSave = vi.fn();
    await mountForm(<UrlSourceForm status={status} version={1} saving={false} onSave={onSave} />);
    await typeInto(byLabel("List source"), "   ");
    await click(buttonByText("Save source URL"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["source_url is required"]);
  });
});

describe("UrlOverridesDialog", () => {
  it("keeps Save disabled until both a value and a category are chosen, without showing errors", async () => {
    await mountForm(withQueryClient(<UrlOverridesDialog open isAdmin onClose={vi.fn()} />));
    expect(buttonByText("Save override").disabled).toBe(true);
    await typeInto(byLabel("Domain"), "example.com");
    expect(buttonByText("Save override").disabled).toBe(true);
    expect(fieldErrors()).toEqual([]);
    expect(text()).toContain("No overrides yet. Add one above.");
  });

  it("says the list could not load instead of reading a failed load as no overrides", async () => {
    api.urlCategorizationOverridesList.mockRejectedValueOnce(new Error("boom"));
    await mountForm(withQueryClient(<UrlOverridesDialog open isAdmin onClose={vi.fn()} />));
    expect(text()).toContain("Couldn't load the overrides. boom");
    expect(text()).not.toContain("No overrides yet");
    await click(buttonByText("Try again"));
    expect(text()).toContain("No overrides yet. Add one above.");
  });

  it("says the categories could not load, since none can be chosen", async () => {
    api.urlCategorizationCategoriesGet.mockRejectedValueOnce(new Error("nope"));
    await mountForm(withQueryClient(<UrlOverridesDialog open isAdmin onClose={vi.fn()} />));
    expect(text()).toContain("Couldn't load the categories, so none can be chosen.");
    expect(buttons()).toContain("Try again");
  });

  it("asks before removing an override and says what removal does", async () => {
    api.urlCategorizationOverridesList.mockResolvedValue({ rows: [override] });
    await mountForm(withQueryClient(<UrlOverridesDialog open isAdmin onClose={vi.fn()} />));
    expect(text()).toContain("github.com");
    expect(text()).toContain("Domain → Games · Work tool");
    const remove = () =>
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove override for github.com"]',
      )!;
    await click(remove());
    expect(api.urlCategorizationOverridesDelete).not.toHaveBeenCalled();
    expect(text()).toContain("Pages that match it go back to the category from the lists.");
    await click(buttonByText("Keep"));
    expect(text()).not.toContain("Pages that match it go back");
    await click(remove());
    await click(buttonByText("Remove override"));
    expect(api.urlCategorizationOverridesDelete).toHaveBeenCalledWith("domain", 1);
    expect(text()).toContain("Removed the override for github.com.");
  });

  it("reports how much each re-categorize action touched", async () => {
    await mountForm(withQueryClient(<UrlOverridesDialog open isAdmin onClose={vi.fn()} />));
    await click(buttonByText("Categorize uncategorized visits"));
    expect(text()).toContain("Queued 500 visits that had no category for categorizing.");
    await click(buttonByText("Re-categorize recent sessions"));
    expect(text()).toContain("Updated 1 session.");
  });
});
