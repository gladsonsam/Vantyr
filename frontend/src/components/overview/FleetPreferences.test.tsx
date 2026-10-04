// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../lib/types";
import { fleetPreferenceScope, fleetServerScope, parseFleetPreferences } from "../../lib/fleetPreferences";
import { AgentFleetTable } from "./AgentFleetTable";
import { OverviewPage } from "../../pages/OverviewPage";
import { api } from "../../lib/api";
vi.mock("../../lib/api", () => ({ api: {
  fleetSummary: vi.fn().mockResolvedValue({agents:{},missing:[]}),
  me: vi.fn(), windows: vi.fn().mockResolvedValue({ rows: [] }), agentInfo: vi.fn().mockResolvedValue({ info: null }),
  agentInternetBlockedGet: vi.fn().mockResolvedValue({ blocked: false }), appBlockRulesList: vi.fn().mockResolvedValue({ rules: [] }),
} }));
vi.mock("../../lib/serverVersionStore", () => ({ useServerVersionPayload: () => null }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("./AddAgentModal", () => ({ AddAgentModal: () => null }));
const a: Agent = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", online: true, last_seen: "2026-01-01", first_seen: "2026-01-01", connected_at: null, last_connected_at: null, last_disconnected_at: null };
const b: Agent = { ...a, id: "22222222-2222-4222-8222-222222222222", name: "Beta", online: false };
const base = { agents: { [a.id]: a, [b.id]: b }, liveStatus: {}, agentInfo: {}, agentInfoReceivedAtMs: {}, onSelectAgent: vi.fn(), onOpenScreen: vi.fn(), onRefresh: vi.fn(), onBatchWake: vi.fn(), onBulkScript: vi.fn(), onBatchLock: vi.fn(), onBatchRestart: vi.fn(), onBatchShutdown: vi.fn() };
let root: Root;
let container: HTMLDivElement;
let scope: string;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); vi.clearAllMocks();
  vi.mocked(api.me).mockResolvedValue({ id: "user-a", username: "alice", role: "admin" });
  scope = fleetPreferenceScope(fleetServerScope(), "user-a");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render(props = {}) { await act(async () => root.render(<AgentFleetTable {...base} preferenceScope={scope} {...props} />)); }
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") || button.textContent?.trim()) === label && !button.disabled);
  expect(button, label).toBeDefined(); await act(async () => button!.click());
}
async function change(label: string, value: string) {
  const control = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  expect(control, label).toBeTruthy();
  const details = control.closest("details");
  if (details && !details.open) await act(async () => details.querySelector("summary")!.click());
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!;
    setter.call(control, value); control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
function favorite(name: string) { return container.querySelector<HTMLButtonElement>(`[aria-label="Favorite ${name}"]`)!; }
function stored() { return parseFleetPreferences(localStorage.getItem(scope)); }
async function save(name: string) { await change("Fleet view name", name); await click("Save view"); }

describe("browser-local fleet preferences", () => {
  for (const mode of ["grid", "table"] as const) {
    it(`toggles UUID favorites in ${mode}, preserves sorting and reloads them`, async () => {
      await render({ controlledViewMode: mode }); await change("Sort devices", "name"); await change("Sort direction", "desc");
      expect([...container.querySelectorAll('[aria-label^="Favorite "]')].map((button) => button.getAttribute("aria-label"))).toEqual(["Favorite Beta", "Favorite Alpha"]);
      const button = favorite("Alpha"); expect(button.style.width).toBe("44px"); expect(button.style.height).toBe("44px");
      await click("Favorite Alpha"); expect(base.onSelectAgent).not.toHaveBeenCalled(); expect(stored().favorites).toEqual([a.id]);
      await click("Favorites only"); expect(container.textContent).toContain("1 of 2 devices shown"); expect(favorite("Beta")).toBeNull();
      await act(async () => root.unmount()); root = createRoot(container); await render({ controlledViewMode: mode });
      expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("true"); expect(container.querySelector<HTMLSelectElement>('[aria-label="Sort direction"]')!.value).toBe("desc");
      await click("Favorites only"); await click("Favorite Alpha"); expect(container.textContent).toContain("0 of 2 devices shown"); expect(container.textContent).toContain("Clear filters to show the fleet");
      await click("Clear filters"); expect(container.textContent).toContain("2 of 2 devices shown");
    });
  }
  it("saves, reloads, applies and removes all view/filter fields", async () => {
    await render(); await click("Favorite Beta"); await click("Favorites only"); await change("Search fleet devices", "Beta"); await change("Device status", "offline"); await change("Fleet view mode", "table"); await change("Sort devices", "name"); await change("Sort direction", "desc"); await save("Offline favorites");
    expect(stored().views[0]).toEqual({ name: "Offline favorites", search: "Beta", status: "offline", view: "table", sort: { key: "name", direction: "desc" }, favoritesOnly: true });
    await act(async () => root.unmount()); root = createRoot(container); await render();
    await change("Saved fleet view", "Offline favorites"); await click("Apply view");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Search fleet devices"]')!.value).toBe("Beta"); expect(container.querySelector<HTMLSelectElement>('[aria-label="Device status"]')!.value).toBe("offline"); expect(container.querySelector<HTMLSelectElement>('[aria-label="Fleet view mode"]')!.value).toBe("table");
    expect(container.querySelector('button[aria-pressed="true"]')!.textContent).toBe("Favorites only"); expect(container.textContent).toContain("1 of 2 devices shown");
    await click("Remove view"); expect(stored().views).toEqual([]); expect(stored().favorites).toEqual([b.id]); expect(api.me).not.toHaveBeenCalled();
  });
  it("prunes removals and selection, and never favorites a replacement with the same name", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    await render({ onDeleteAgents: remove }); await click("Favorite Alpha");
    const selected = container.querySelector<HTMLInputElement>('[aria-label="Select Alpha"]')!; await act(async () => selected.click());
    await click("Remove device Alpha"); await click("Remove devices"); expect(remove).toHaveBeenCalledWith([a.id]); expect(stored().favorites).toEqual([]); expect(container.textContent).not.toContain("1 selected");
    await click("Favorite Beta"); const betaSelection = container.querySelector<HTMLInputElement>('[aria-label="Select Beta"]')!; await act(async () => betaSelection.click());
    const replacement = { ...b, id: "33333333-3333-4333-8333-333333333333" };
    await render({ agents: { [a.id]: a, [replacement.id]: replacement }, onDeleteAgents: remove });
    expect(stored().favorites).toEqual([]); expect(favorite("Beta").getAttribute("aria-pressed")).toBe("false"); expect(container.textContent).not.toContain("1 selected");
  });
  it("isolates account/server scopes and rejects corrupt stored views", async () => {
    await render({ onDeleteAgents: vi.fn() }); await click("Favorite Alpha"); await save("Private view");
    const selected = container.querySelector<HTMLInputElement>('[aria-label="Select Alpha"]')!; await act(async () => selected.click());
    const foreign = fleetPreferenceScope(fleetServerScope(), "user-b"); await render({ preferenceScope: foreign, onDeleteAgents: vi.fn() });
    expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("false"); expect(container.textContent).not.toContain("Private view"); expect(container.textContent).not.toContain("1 selected");
    await click("Favorite Beta"); expect(stored().favorites).toEqual([a.id]); expect(parseFleetPreferences(localStorage.getItem(foreign)).favorites).toEqual([b.id]);
    const corrupt = fleetPreferenceScope("https://other.example/api/", "user-a"); localStorage.setItem(corrupt, "{bad"); await render({ preferenceScope: corrupt });
    expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("false"); expect(container.querySelector<HTMLSelectElement>('[aria-label="Saved fleet view"]')!.options.length).toBe(1);
  });
  it("keeps the verified account across a same-user focus re-check, and hides it for another account or session expiry", async () => {
    await act(async () => root.render(<OverviewPage {...base} loadingAgents={false} />)); await click("Favorite Alpha"); await save("Alice only"); expect(api.me).toHaveBeenCalledTimes(1);
    let resolve!: (user: Awaited<ReturnType<typeof api.me>>) => void; vi.mocked(api.me).mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => window.dispatchEvent(new Event("focus"))); expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("true"); expect(container.textContent).toContain("Alice only");
    await act(async () => resolve({ id: "user-a", username: "alice", role: "admin" })); expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("true"); expect(container.textContent).toContain("Alice only");
    await act(async () => window.dispatchEvent(new Event("focus"))); await act(async () => resolve({ id: "user-b", username: "bob", role: "admin" }));
    expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("false"); expect(container.textContent).not.toContain("Alice only");
    await act(async () => window.dispatchEvent(new Event("vantyr-session-expired"))); expect(favorite("Alpha").disabled).toBe(true);
  });
});


describe("storage and server changes", () => {
  it("keeps blocked-storage preferences usable for this session without crossing scopes", async () => {
    const sessionScope=fleetPreferenceScope(fleetServerScope(),"blocked-storage-user");
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(() => {throw new Error("Storage blocked");});
    await render({preferenceScope:sessionScope}); await click("Favorite Alpha"); await save("Session view");
    expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("true"); expect(localStorage.getItem(sessionScope)).toBeNull();
    await act(async()=>root.unmount());root=createRoot(container);await render({preferenceScope:sessionScope});
    expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("true");expect(container.textContent).toContain("Session view");
    await render({preferenceScope:fleetPreferenceScope(fleetServerScope(),"different-storage-user")});
    expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("false");expect(container.textContent).not.toContain("Session view");
  });
  it("rechecks identity for a changed configured server and prunes the final device", async () => {
    await act(async()=>root.render(<OverviewPage {...base} loadingAgents={false}/>));await click("Favorite Alpha");await save("Server one");
    await act(async()=>{localStorage.setItem("vantyr-server-settings",JSON.stringify({serverOrigin:"https://other.example"}));window.dispatchEvent(new StorageEvent("storage",{key:"vantyr-server-settings"}));});
    expect(api.me).toHaveBeenCalledTimes(2);expect(favorite("Alpha").getAttribute("aria-pressed")).toBe("false");expect(container.textContent).not.toContain("Server one");
    await click("Favorite Alpha");const other=fleetPreferenceScope(fleetServerScope(),"user-a");
    await act(async()=>root.render(<OverviewPage {...base} agents={{}} loadingAgents={false}/>));
    expect(parseFleetPreferences(localStorage.getItem(other)).favorites).toEqual([]);expect(stored().favorites).toEqual([a.id]);
  });
});
