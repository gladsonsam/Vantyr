// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQueryClient } from "@/test/queryClient";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@/test/formDom";
import type { UrlCategorizationStatus } from "../hooks/useUrlCategorization";
import { UrlOverridesDialog } from "./UrlOverridesDialog";
import { UrlSourceForm } from "./UrlSourceForm";

const api = vi.hoisted(() => ({
  urlCategorizationOverridesList: vi.fn(async () => ({ rows: [] })),
  urlCategorizationCategoriesGet: vi.fn(async () => ({ categories: [{ key: "games", label: "Games", enabled: true, description: "" }] })),
}));
vi.mock("@/api", () => ({ api }));

afterEach(() => {
  unmountForms();
  vi.clearAllMocks();
});

const status: UrlCategorizationStatus = {
  settings: { enabled: true, auto_update: true, source_url: "https://example.com/list.tar.gz", last_update_at: null, last_update_error: null },
  active_release: { sha256: null },
  counts: { categories: 0, domains: 0, urls: 0 },
  job: null,
};

describe("UrlSourceForm", () => {
  it("starts from the server's source URL and saves the typed one", async () => {
    const onSave = vi.fn();
    await mountForm(<UrlSourceForm status={status} version={1} saving={false} onSave={onSave} />);
    expect(byLabel("Source URL").value).toBe("https://example.com/list.tar.gz");
    await typeInto(byLabel("Source URL"), " https://mirror.local/ut1.tar.gz ");
    await click(buttonByText("Save source URL"));
    expect(onSave).toHaveBeenCalledWith("https://mirror.local/ut1.tar.gz");
  });

  it("shows 'source_url is required' and does not save a blank URL", async () => {
    const onSave = vi.fn();
    await mountForm(<UrlSourceForm status={status} version={1} saving={false} onSave={onSave} />);
    await typeInto(byLabel("Source URL"), "   ");
    await click(buttonByText("Save source URL"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["source_url is required"]);
  });
});

describe("UrlOverridesDialog", () => {
  it("keeps Add disabled until both a value and a category are chosen, without showing errors", async () => {
    await mountForm(withQueryClient(<UrlOverridesDialog open isAdmin onClose={vi.fn()} />));
    expect(buttonByText("Add / update override").disabled).toBe(true);
    await typeInto(byLabel("Domain"), "example.com");
    expect(buttonByText("Add / update override").disabled).toBe(true);
    expect(fieldErrors()).toEqual([]);
  });
});
