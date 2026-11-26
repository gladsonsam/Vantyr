import { buttonByText, click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const api = (() => ({
  urlCategorizationCategoriesGet: vi.fn(),
  urlCustomCategoriesList: vi.fn(),
  urlCategorizationCategoriesPut: vi.fn(),
  urlCustomCategoriesCreate: vi.fn(),
  urlCustomCategoriesUpdate: vi.fn(),
  urlCustomCategoriesDelete: vi.fn(),
  urlCustomCategoriesPutMembers: vi.fn(),
}))();
await vi.mock("@/api", () => ({ api }));

const { CategoryManagerModal } = await import("@/features/settings/CategoryManagerModal");

const categories = {
  categories: [
    { key: "games", label: "Games", enabled: true, description: "Play" },
    { key: "news", label: "News", enabled: true, description: "" },
  ],
};
const groups = {
  rows: [
    {
      id: 7,
      key: "fun",
      label_en: "Fun",
      description_en: "",
      display_order: 0,
      hidden: false,
      updated_at: "",
      member_count: 1,
      ut1_keys: ["games"],
    },
  ],
};

const text = () => document.body.textContent ?? "";
const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

beforeEach(() => {
  vi.clearAllMocks();
  api.urlCategorizationCategoriesGet.mockResolvedValue(categories);
  api.urlCustomCategoriesList.mockResolvedValue(groups);
  api.urlCategorizationCategoriesPut.mockResolvedValue({ categories: [] });
  api.urlCustomCategoriesUpdate.mockResolvedValue({});
  api.urlCustomCategoriesPutMembers.mockResolvedValue({});
});
afterEach(unmountForms);

const open = (onDismiss = vi.fn()) =>
  mountForm(withQueryClient(<CategoryManagerModal visible onDismiss={onDismiss} />));

describe("CategoryManagerModal", () => {
  it("shows no editor when the lists could not load, so an empty draft cannot be saved over them", async () => {
    api.urlCategorizationCategoriesGet.mockRejectedValueOnce(new Error("boom"));
    await open();
    expect(text()).toContain("Couldn't load the categories. boom");
    expect(text()).not.toContain("No categories yet");
    expect(buttonByText("Save changes").disabled).toBe(true);
    expect(document.querySelectorAll("input[aria-label='Search categories']")).toHaveLength(0);
    await click(buttonByText("Try again"));
    expect(text()).toContain("List categories");
  });

  it("explains hiding and lists each category with its name, group and visibility", async () => {
    await open();
    expect(text()).toContain("A hidden category disappears from analytics and URL history.");
    expect(document.querySelector<HTMLInputElement>("#cat-games-label")!.value).toBe("Games");
    expect(
      document.querySelector(
        '[role="switch"][aria-label="Show games in analytics and URL history"]',
      ),
    ).not.toBeNull();
    expect(text()).toContain("1 category");
  });

  it("lets a renamed group be saved on its own, counting it as an unsaved change", async () => {
    await open();
    expect(buttonByText("Save changes").disabled).toBe(true);
    await typeInto(input("Name of group fun"), "Fun and games");
    expect(buttonByText("Save changes").disabled).toBe(false);
    expect(text()).toContain("1 unsaved change");
    await click(buttonByText("Save changes"));
    expect(api.urlCustomCategoriesUpdate).toHaveBeenCalledWith(7, {
      label_en: "Fun and games",
      hidden: false,
    });
  });

  it("blocks saving a group with a blank name and says why", async () => {
    await open();
    await typeInto(input("Name of group fun"), "  ");
    expect(buttonByText("Save changes").disabled).toBe(true);
    expect(text()).toContain("Every group needs a name.");
  });

  it("refuses a group name that collides with an existing group", async () => {
    await open();
    await typeInto(input("New group name"), "Fun");
    await click(buttonByText("Add group"));
    expect(text()).toContain("A group with this name already exists.");
    expect(text()).not.toContain("unsaved change");
  });

  it("keeps a new group out of reach until it is saved", async () => {
    await open();
    await typeInto(input("New group name"), "Study");
    await click(buttonByText("Add group"));
    expect(text()).toContain("Not saved yet. Save to start assigning categories.");
    expect(text()).toContain("1 unsaved change");
  });

  it("asks before closing with unsaved edits, and closes straight away without any", async () => {
    const onDismiss = vi.fn();
    await open(onDismiss);
    await click(buttonByText("Close"));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await typeInto(input("Name of group fun"), "Fun and games");
    await click(buttonByText("Close"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Discard 1 unsaved change?");
    await click(buttonByText("Keep editing"));
    expect(input("Name of group fun").value).toBe("Fun and games");
    await click(buttonByText("Close"));
    await click(buttonByText("Discard and close"));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("restores the saved values with Discard changes", async () => {
    await open();
    await typeInto(input("Name of group fun"), "Other");
    expect(buttons()).toContain("Discard changes");
    await click(buttonByText("Discard changes"));
    expect(input("Name of group fun").value).toBe("Fun");
    expect(buttons()).not.toContain("Discard changes");
  });

  it("keeps the edits and warns that some changes may be applied when a save fails midway", async () => {
    api.urlCustomCategoriesUpdate.mockRejectedValueOnce(new Error("conflict"));
    await open();
    await typeInto(input("Name of group fun"), "Other");
    await click(buttonByText("Save changes"));
    expect(text()).toContain("Not saved completely. conflict Some changes may already be applied");
    expect(input("Name of group fun").value).toBe("Other");
  });
});
