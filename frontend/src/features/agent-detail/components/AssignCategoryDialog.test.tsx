// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, mountForm, typeInto, unmountForms } from "@/test/formDom";
import { withQueryClient } from "@/test/queryClient";
import { AssignCategoryDialog } from "./AssignCategoryDialog";

const backend = vi.hoisted(() => ({
  urlCategorizationCategoriesGet: vi.fn(),
  urlCustomCategoriesList: vi.fn(),
  urlCategorizationOverridesUpsert: vi.fn(),
  urlCategorizationRecalcUrlSessions: vi.fn(),
}));
vi.mock("@/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api")>()), api: backend }));

const target = { kind: "domain" as const, value: "example.com", hostname: "example.com", url: null };

beforeEach(() => {
  backend.urlCategorizationCategoriesGet.mockReset().mockResolvedValue({ categories: [{ key: "news", label: "News", enabled: true }] });
  backend.urlCustomCategoriesList.mockReset().mockResolvedValue({
    rows: [{ id: 1, key: "work", label_en: "Work", hidden: false, ut1_keys: ["news"] }],
  });
  backend.urlCategorizationOverridesUpsert.mockReset().mockResolvedValue({ ok: true });
  backend.urlCategorizationRecalcUrlSessions.mockReset().mockResolvedValue({ ok: true });
});
afterEach(unmountForms);

const text = () => document.body.textContent ?? "";

describe("AssignCategoryDialog", () => {
  it("shows what is being categorised and keeps Save disabled until a category is chosen", async () => {
    await mountForm(withQueryClient(<AssignCategoryDialog target={target} agentId="a1" canAdmin onClose={vi.fn()} />));
    expect(text()).toContain("Domain");
    expect(text()).toContain("example.com");
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(document.getElementById("assign-note") as HTMLTextAreaElement, "a note");
    expect(buttonByText("Save").disabled).toBe(true);
  });

  it("renders nothing while there is no target", async () => {
    await mountForm(withQueryClient(<AssignCategoryDialog target={null} agentId="a1" canAdmin onClose={vi.fn()} />));
    expect(text()).not.toContain("Assign category");
  });

  it("closes on Cancel", async () => {
    const onClose = vi.fn();
    await mountForm(withQueryClient(<AssignCategoryDialog target={target} agentId="a1" canAdmin onClose={onClose} />));
    await click(buttonByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves the override for the chosen custom category's UT1 key with the trimmed note", async () => {
    const onClose = vi.fn();
    await mountForm(withQueryClient(<AssignCategoryDialog target={target} agentId="a1" canAdmin onClose={onClose} />));
    await act(async () => {});
    await click(document.getElementById("assign-custom") as HTMLElement);
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent?.trim() === "Work");
    expect(option).toBeTruthy();
    await click(option!);
    await typeInto(document.getElementById("assign-note") as HTMLTextAreaElement, " because ");
    expect(buttonByText("Save").disabled).toBe(false);
    await click(buttonByText("Save"));
    expect(backend.urlCategorizationOverridesUpsert).toHaveBeenCalledWith({
      kind: "domain", value: "example.com", category_key: "news", note: "because",
    });
    expect(backend.urlCategorizationRecalcUrlSessions).toHaveBeenCalledWith({ limit: 50_000 });
    expect(onClose).toHaveBeenCalled();
  });
});
