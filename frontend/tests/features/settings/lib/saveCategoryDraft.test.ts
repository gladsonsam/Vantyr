import { testMock as vi } from "@tests/support/mock";
import { beforeEach, describe, expect, it } from "bun:test";

const api = (() => ({
  urlCategorizationCategoriesPut: vi.fn<
    (body: { categories: { key: string; enabled: boolean }[] }) => Promise<object>
  >(async () => ({})),
  urlCustomCategoriesCreate: vi.fn<(body: unknown) => Promise<{ id: number }>>(async () => ({
    id: 99,
  })),
  urlCustomCategoriesUpdate: vi.fn<(id: number, body: unknown) => Promise<object>>(
    async () => ({}),
  ),
  urlCustomCategoriesDelete: vi.fn<(id: number) => Promise<{ ok: boolean }>>(async () => ({
    ok: true,
  })),
  urlCustomCategoriesPutMembers: vi.fn<(id: number, body: unknown) => Promise<object>>(
    async () => ({}),
  ),
}))();
await vi.mock("@/api", () => ({ api }));
const { addGroup, patchCategory, removeGroup, toDraft } =
  await import("@/features/settings/lib/categoryDraft");
const { saveCategoryDraft } = await import("@/features/settings/lib/saveCategoryDraft");

const draft = () =>
  toDraft({
    categories: {
      categories: [
        { key: "games", label: "Games", description: "", enabled: true },
        { key: "news", label: "News", description: "", enabled: true },
      ],
    },
    groups: {
      rows: [
        { id: 7, key: "fun", label_en: "Fun", hidden: false, ut1_keys: ["games"] },
        { id: 8, key: "old", label_en: "Old", hidden: false, ut1_keys: [] },
      ],
    },
  });

beforeEach(() => vi.clearAllMocks());

describe("saveCategoryDraft", () => {
  it("creates new groups before assigning members to them, using the id the server returned", async () => {
    const order: string[] = [];
    api.urlCategorizationCategoriesPut.mockImplementationOnce(async () => {
      order.push("categories");
      return {};
    });
    api.urlCustomCategoriesCreate.mockImplementationOnce(async () => {
      order.push("create");
      return { id: 99 };
    });
    api.urlCustomCategoriesPutMembers.mockImplementation(async (id: number) => {
      order.push(`members:${id}`);
      return {};
    });
    await saveCategoryDraft(addGroup(patchCategory(draft(), "news", { enabled: false }), "Study"));
    expect(api.urlCustomCategoriesCreate).toHaveBeenCalledWith({
      key: "study",
      label_en: "Study",
      hidden: false,
    });
    expect(api.urlCategorizationCategoriesPut.mock.calls[0][0].categories[1]).toMatchObject({
      key: "news",
      enabled: false,
    });
    expect(order).toEqual(["categories", "create", "members:7", "members:8", "members:99"]);
    expect(api.urlCustomCategoriesPutMembers).toHaveBeenCalledWith(7, { ut1_keys: ["games"] });
    expect(api.urlCustomCategoriesPutMembers).toHaveBeenCalledWith(99, { ut1_keys: [] });
  });

  it("deletes removed groups, tolerating only an already-missing group", async () => {
    api.urlCustomCategoriesDelete.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { status: 404 }),
    );
    await saveCategoryDraft(removeGroup(draft(), 1));
    expect(api.urlCustomCategoriesDelete).toHaveBeenCalledWith(8);
    expect(api.urlCustomCategoriesPutMembers).toHaveBeenCalledTimes(1);
    expect(api.urlCustomCategoriesPutMembers).toHaveBeenCalledWith(7, { ut1_keys: ["games"] });
  });

  it("reports a refused group deletion instead of reporting a complete save", async () => {
    api.urlCustomCategoriesDelete.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(saveCategoryDraft(removeGroup(draft(), 1))).rejects.toThrow("Forbidden");
    expect(api.urlCustomCategoriesPutMembers).not.toHaveBeenCalled();
  });

  it("stops at the first failed request", async () => {
    api.urlCategorizationCategoriesPut.mockRejectedValueOnce(new Error("boom"));
    await expect(saveCategoryDraft(draft())).rejects.toThrow("boom");
    expect(api.urlCustomCategoriesPutMembers).not.toHaveBeenCalled();
  });
});
