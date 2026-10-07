// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentInfo, FleetSummaryResponse } from "@/api/types";
import { api } from "@/api";
import {
  fleetPreferenceScope,
  parseFleetPreferences,
  useFleetPreferences,
  useFleetPreferenceScope,
} from "@/features/fleet/lib/fleetPreferences";
import { fleetServerScope } from "@/hooks/useVerifiedUser";
import { FleetOverview } from "./FleetOverview";
import { notifySessionExpired } from "@/api/sessionExpiry";

vi.mock("@/api", () => ({
  apiUrl: (path: string) => path,
  api: {
    fleetSummary: vi.fn(),
    windows: vi.fn().mockResolvedValue({ rows: [] }),
    agentInfo: vi.fn().mockResolvedValue({ info: null }),
    agentInternetBlockedGet: vi.fn().mockResolvedValue({ blocked: true }),
    appBlockRulesList: vi.fn().mockResolvedValue({ rules: [] }),
    deleteAgents: vi.fn(),
    me: vi.fn(),
  },
}));
vi.mock("@/api/serverVersionStore", () => ({ useServerVersionPayload: () => null }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

// jsdom has no PointerEvent; Base UI buttons/checkboxes construct one on click.
if (typeof window !== "undefined" && typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (window as unknown as { PointerEvent?: unknown }).PointerEvent = MouseEvent;
}

type FleetProps = ComponentProps<typeof FleetOverview>;

const pc: Agent = {
  id: "pc", name: "Office PC", online: false, last_seen: "2026-01-01", first_seen: "2026-01-01",
  connected_at: null, last_connected_at: null, last_disconnected_at: null,
};
const a: Agent = {
  id: "11111111-1111-4111-8111-111111111111", name: "Alpha", online: true, last_seen: "2026-01-01",
  first_seen: "2026-01-01", connected_at: null, last_connected_at: null, last_disconnected_at: null,
};
const b: Agent = { ...a, id: "22222222-2222-4222-8222-222222222222", name: "Beta", online: false };

function makeProps(overrides: Partial<FleetProps> = {}): FleetProps {
  return {
    preferenceScope: "test-user-server",
    agents: { pc },
    liveStatus: {},
    agentInfo: {},
    agentInfoReceivedAtMs: {},
    loadingAgents: false,
    onSelectAgent: vi.fn(),
    onOpenScreen: vi.fn(),
    onRefresh: vi.fn(),
    onBatchWake: vi.fn(),
    onBulkScript: vi.fn(),
    onBatchLock: vi.fn(),
    onBatchRestart: vi.fn(),
    onBatchShutdown: vi.fn(),
    ...overrides,
  };
}

/** Harness mimicking AuthenticatedOverview: verified scope + pruning + api-backed deletes. */
function ScopedFleet({ agents, ...rest }: Partial<FleetProps> & { agents: Record<string, Agent> }) {
  const scope = useFleetPreferenceScope();
  const [preferences, updatePreferences] = useFleetPreferences(scope);
  useEffect(() => {
    if (preferences.favorites.some((id) => !agents[id])) {
      updatePreferences((previous) => ({ ...previous, favorites: previous.favorites.filter((id) => Boolean(agents[id])) }));
    }
  }, [agents, preferences.favorites, updatePreferences]);
  return (
    <FleetOverview
      preferenceScope={scope}
      liveStatus={{}}
      agentInfo={{}}
      agentInfoReceivedAtMs={{}}
      loadingAgents={false}
      onSelectAgent={vi.fn()}
      onOpenScreen={vi.fn()}
      onRefresh={vi.fn()}
      onBatchWake={vi.fn()}
      onBulkScript={vi.fn()}
      onBatchLock={vi.fn()}
      onBatchRestart={vi.fn()}
      onBatchShutdown={vi.fn()}
      onDeleteAgents={async (ids: string[]) => {
        await api.deleteAgents(ids);
      }}
      {...rest}
      agents={agents}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.fleetSummary).mockImplementation(async (ids: readonly string[]) => ({
    agents: Object.fromEntries(
      ids.map((id) => [id, { info: null, info_reported_at: null, last_window: null, internet_blocked: true, internet_block_source: "agent" as const, app_block_enabled_count: 0 }]),
    ),
    missing: [],
  }));
  vi.mocked(api.me).mockResolvedValue({ id: "user-a", username: "alice", role: "admin" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderFleet(props: FleetProps) {
  await act(async () => {
    root.render(<FleetOverview {...props} />);
  });
  // Flush the fleet-summary enrichment round.
  await act(async () => {});
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") || candidate.textContent?.trim()) === label && !candidate.disabled,
  );
  expect(button, label).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await act(async () => {});
}

async function clickTab(label: string) {
  const tab = [...document.querySelectorAll('[role="tab"]')].find((candidate) =>
    candidate.textContent?.trim().startsWith(label),
  );
  expect(tab, label).toBeDefined();
  await act(async () => {
    (tab as HTMLElement).click();
  });
  await act(async () => {});
}

function selectedTab(): string | null {
  const tab = [...document.querySelectorAll('[role="tab"]')].find((candidate) => candidate.getAttribute("aria-selected") === "true");
  return tab?.textContent?.trim() ?? null;
}

async function clickMenuItem(label: string) {
  const item = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(item, label).toBeDefined();
  await act(async () => {
    (item as HTMLElement).click();
  });
  await act(async () => {});
}

async function closeMenus() {
  await act(async () => {
    const menu = document.querySelector('[role="menu"]');
    (menu ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

async function setSort(keyLabel: string, orderLabel: string) {
  await clickButton("Sort devices");
  await clickMenuItem(keyLabel);
  await clickMenuItem(orderLabel);
  await closeMenus();
}

async function typeSearch(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search fleet devices"]')!;
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {});
}

async function saveView(name: string) {
  await clickButton("Views");
  await clickMenuItem("Save current view…");
  const input = document.getElementById("fleet-view-name") as HTMLInputElement | null;
  expect(input, "fleet-view-name").toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input!, name);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickButton("Save view");
}

async function applyView(name: string) {
  await clickButton("Views");
  await clickMenuItem(name);
  await closeMenus();
}

async function removeView(name: string) {
  await clickButton("Views");
  const sub = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === "Remove a view" && candidate.getAttribute("aria-haspopup") === "menu",
  );
  expect(sub, "Remove a view").toBeDefined();
  await act(async () => {
    sub!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    sub!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    sub!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    // The submenu opens on hover after a short delay.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await act(async () => {});
  const menus = [...document.querySelectorAll('[role="menu"]')];
  expect(menus.length).toBeGreaterThan(1);
  const subMenu = menus[menus.length - 1];
  const item = [...subMenu.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === name);
  expect(item, name).toBeDefined();
  await act(async () => {
    (item as HTMLElement).click();
  });
  await act(async () => {});
  await closeMenus();
}

/** Saved view names only surface inside the Views menu; assert presence there. */
async function viewListed(name: string): Promise<boolean> {
  await clickButton("Views");
  const found = [...document.querySelectorAll('[role="menuitem"]')].some(
    (candidate) => candidate.textContent?.trim() === name,
  );
  await closeMenus();
  return found;
}

function favorite(name: string) {
  return container.querySelector<HTMLButtonElement>(`[aria-label="Favorite ${name}"]`);
}

function favoriteOrder(): (string | null)[] {
  return [...container.querySelectorAll('[aria-label^="Favorite "]')].map((button) => button.getAttribute("aria-label"));
}

describe("fleet removal", () => {
  for (const mode of ["grid", "table"] as const) {
    it(`requires confirmation in ${mode} and retains it on failure until retry succeeds`, async () => {
      let reject!: (reason: Error) => void;
      const remove = vi
        .fn()
        .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }))
        .mockResolvedValue(undefined);
      const props = makeProps({ controlledViewMode: mode, onDeleteAgents: remove });
      await renderFleet(props);
      expect(container.textContent).toContain("Offline");
      // Configured internet block is shown; app-rule counts never are.
      expect(container.textContent).toContain("Internet block");
      expect(container.textContent).not.toContain("Enabled app rules");
      if (mode === "table") {
        await clickButton("List view");
      }
      // Per-row removal goes through the row actions menu.
      await clickButton("More actions for Office PC");
      await clickMenuItem("Remove device…");
      expect(remove).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Affected: Office PC");
      await clickButton("Remove devices");
      expect(remove).toHaveBeenCalledWith(["pc"]);
      expect(props.onRefresh).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Affected: Office PC");
      await act(async () => reject(new Error("Removal denied")));
      expect(document.querySelector('[role="alert"]')?.textContent).toBe("Removal denied");
      await clickButton("Remove devices");
      expect(props.onRefresh).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).not.toContain("Affected:");
    });
  }

  it("propagates API rejection and preserves bulk selection", async () => {
    vi.mocked(api.deleteAgents).mockRejectedValue(new Error("Server unavailable"));
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(<ScopedFleet agents={{ pc }} onRefresh={onRefresh} />);
    });
    await act(async () => {});
    await clickButton("List view");
    const selectAll = container.querySelector<HTMLElement>('[aria-label="Select all visible devices"]')!;
    await act(async () => {
      selectAll.click();
    });
    await act(async () => {});
    expect(container.textContent).toContain("1 selected");
    await clickButton("Remove devices (1)");
    await clickButton("Remove devices");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Server unavailable");
    expect(container.textContent).toContain("1 selected");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("persists sorting across view-mode switches and remounts", async () => {
    const props = makeProps({ agents: { [a.id]: a, [b.id]: b } });
    await renderFleet(props);
    expect(favoriteOrder()).toEqual(["Favorite Alpha", "Favorite Beta"]);
    await setSort("Name", "Z–A");
    expect(favoriteOrder()).toEqual(["Favorite Beta", "Favorite Alpha"]);
    expect(JSON.parse(localStorage.getItem("vantyr.fleet-sort.v1")!)).toEqual({ key: "name", direction: "desc" });
    await clickButton("List view");
    expect(favoriteOrder()).toEqual(["Favorite Beta", "Favorite Alpha"]);
    await clickButton("Grid view");
    expect(favoriteOrder()).toEqual(["Favorite Beta", "Favorite Alpha"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderFleet(makeProps({ agents: { [a.id]: a, [b.id]: b } }));
    expect(favoriteOrder()).toEqual(["Favorite Beta", "Favorite Alpha"]);
    expect(JSON.parse(localStorage.getItem("vantyr.fleet-sort.v1")!)).toEqual({ key: "name", direction: "desc" });
  });
});

describe("fleet enrichment", () => {
  const stored: FleetSummaryResponse = {
    agents: {
      pc: {
        info: { hostname: "Stored host", current_user: "Stored user", uptime_secs: 120 },
        info_reported_at: "2026-01-01T00:00:00Z",
        last_window: { app: "old.exe", title: "Historical window", reported_at: "2026-01-01T00:00:00Z" },
        internet_blocked: false,
        internet_block_source: null,
        app_block_enabled_count: 0,
      },
    },
    missing: [],
  };

  it("enriches by fleet batch, keeps live events ahead of late history and does not refetch on live updates or search", async () => {
    let resolve!: (value: FleetSummaryResponse) => void;
    vi.mocked(api.fleetSummary).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const props = makeProps();
    await renderFleet(props);
    await renderFleet({
      ...props,
      agentInfo: { pc: { current_user: "Live user", uptime_secs: 60 } as AgentInfo },
      agentInfoReceivedAtMs: { pc: Date.now() },
      liveStatus: { pc: { activity: "active", window: "Live window", app: "live.exe" } },
    });
    await act(async () => resolve(stored));
    expect(container.textContent).toContain("Live window");
    expect(container.textContent).toContain("Live user");
    expect(container.textContent).not.toContain("Historical window");
    expect(container.textContent).not.toContain("Stored user");
    // The new UI omits the negative policy line entirely instead of restating it;
    // app-rule counts must never appear.
    expect(container.textContent).not.toContain("Enabled app rules");
    await renderFleet({ ...props, controlledQuery: "Office", liveStatus: { pc: { window: "Updated live window" } } });
    expect(container.textContent).toContain("Updated live window");
    expect(api.fleetSummary).toHaveBeenCalledTimes(1);
    expect(api.windows).not.toHaveBeenCalled();
    expect(api.agentInfo).not.toHaveBeenCalled();
    expect(api.agentInternetBlockedGet).not.toHaveBeenCalled();
    expect(api.appBlockRulesList).not.toHaveBeenCalled();
  });

  it.each(["grid", "table"] as const)("shows history and unknown policy truthfully in %s; omitted/error results never look like false/zero", async (mode) => {
    vi.mocked(api.fleetSummary).mockResolvedValueOnce(stored);
    await renderFleet(makeProps({ controlledViewMode: mode }));
    expect(container.textContent).toContain("Historical window");
    expect(container.querySelector('[title^="Stored window history"]')).not.toBeNull();
    vi.mocked(api.fleetSummary).mockResolvedValueOnce({ agents: {}, missing: ["pc"] });
    await renderFleet(makeProps({ preferenceScope: "other-user", controlledViewMode: mode }));
    expect(container.textContent).toContain("Device absent from fleet summary");
    expect(container.textContent).not.toContain("Enabled app rules: 0");
    expect(container.textContent).not.toContain("Historical window");
    vi.mocked(api.fleetSummary).mockRejectedValueOnce(new Error("DB failed"));
    await renderFleet(makeProps({ preferenceScope: "other-server", controlledViewMode: mode }));
    expect(container.textContent).toContain("Policy configuration unavailable");
    expect(container.textContent).not.toContain("Enabled app rules: 0");
  });
});

describe("card selection without navigation", () => {
  it("toggles grid selection without opening the device", async () => {
    const onSelectAgent = vi.fn();
    await renderFleet(makeProps({ onSelectAgent, onDeleteAgents: vi.fn().mockResolvedValue(undefined) }));
    const checkbox = container.querySelector<HTMLElement>('[aria-label="Select Office PC"]')!;
    expect(checkbox).toBeTruthy();
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {});
    expect(container.textContent).toContain("1 selected");
    expect(onSelectAgent).not.toHaveBeenCalled();
    // Clicking the card itself still navigates (the selection label shares the
    // cursor-pointer class, so match the card div by its device text).
    const card = [...container.querySelectorAll("div.cursor-pointer")].find((el) =>
      el.textContent?.includes("Office PC"),
    )!;
    expect(card).toBeDefined();
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectAgent).toHaveBeenCalledWith("pc");
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {});
    expect(container.textContent).not.toContain("1 selected");
    expect(onSelectAgent).toHaveBeenCalledTimes(1);
  });
});

describe("browser-local fleet preferences", () => {
  function basePair(overrides: Partial<FleetProps> = {}): FleetProps {
    return makeProps({
      agents: { [a.id]: a, [b.id]: b },
      ...overrides,
    });
  }

  function pairScope() {
    return fleetPreferenceScope(fleetServerScope(), "user-a");
  }

  for (const mode of ["grid", "table"] as const) {
    it(`toggles UUID favorites in ${mode}, preserves sorting and reloads them`, async () => {
      const scope = pairScope();
      const onSelectAgent = vi.fn();
      await renderFleet(basePair({ preferenceScope: scope, controlledViewMode: mode, onSelectAgent }));
      await setSort("Name", "Z–A");
      expect(favoriteOrder()).toEqual(["Favorite Beta", "Favorite Alpha"]);
      await clickButton("Favorite Alpha");
      expect(onSelectAgent).not.toHaveBeenCalled();
      expect(parseFleetPreferences(localStorage.getItem(scope)).favorites).toEqual([a.id]);
      await clickButton("Favorites only");
      expect(favorite("Beta")).toBeNull();
      expect(favoriteOrder()).toEqual(["Favorite Alpha"]);
      await act(async () => root.unmount());
      root = createRoot(container);
      await renderFleet(basePair({ preferenceScope: scope, controlledViewMode: mode, onSelectAgent }));
      expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("true");
      expect(JSON.parse(localStorage.getItem("vantyr.fleet-sort.v1")!)).toEqual({ key: "name", direction: "desc" });
      expect(favoriteOrder()).toEqual(["Favorite Beta", "Favorite Alpha"]);
      await clickButton("Favorites only");
      await clickButton("Favorite Alpha");
      expect(container.textContent).toContain("2 devices are hidden by the current filters.");
      expect(container.textContent).toContain("Clear filters");
      await clickButton("Clear filters");
      expect(favoriteOrder()).toEqual(["Favorite Beta", "Favorite Alpha"]);
    });
  }

  it("saves, reloads, applies and removes all view/filter fields", async () => {
    const scope = pairScope();
    const onSelectAgent = vi.fn();
    await renderFleet(basePair({ preferenceScope: scope, onSelectAgent }));
    await clickButton("Favorite Beta");
    await clickButton("Favorites only");
    await typeSearch("Beta");
    await clickTab("Offline");
    await clickButton("List view");
    await setSort("Name", "Z–A");
    await saveView("Offline favorites");
    expect(parseFleetPreferences(localStorage.getItem(scope)).views[0]).toEqual({
      name: "Offline favorites",
      search: "Beta",
      status: "offline",
      view: "table",
      sort: { key: "name", direction: "desc" },
      favoritesOnly: true,
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderFleet(basePair({ preferenceScope: scope, onSelectAgent }));
    await applyView("Offline favorites");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Search fleet devices"]')!.value).toBe("Beta");
    expect(selectedTab()?.startsWith("Offline")).toBe(true);
    expect(document.querySelector('[aria-label="List view"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[aria-label="Favorites only"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(favorite("Beta")).not.toBeNull();
    expect(favorite("Alpha")).toBeNull();
    await removeView("Offline favorites");
    const storedAfter = parseFleetPreferences(localStorage.getItem(scope));
    expect(storedAfter.views).toEqual([]);
    expect(storedAfter.favorites).toEqual([b.id]);
    expect(api.me).not.toHaveBeenCalled();
  });

  it("prunes removals and selection, and never favorites a replacement with the same name", async () => {
    const scope = pairScope();
    const remove = vi.fn().mockResolvedValue(undefined);
    await renderFleet(basePair({ preferenceScope: scope, onDeleteAgents: remove }));
    await clickButton("Favorite Alpha");
    await clickButton("List view");
    const selected = container.querySelector<HTMLElement>('[aria-label="Select Alpha"]')!;
    await act(async () => {
      selected.click();
    });
    await act(async () => {});
    expect(container.textContent).toContain("1 selected");
    await clickButton("More actions for Alpha");
    await clickMenuItem("Remove device…");
    await clickButton("Remove devices");
    expect(remove).toHaveBeenCalledWith([a.id]);
    expect(parseFleetPreferences(localStorage.getItem(scope)).favorites).toEqual([]);
    expect(container.textContent).not.toContain("1 selected");
    await clickButton("Favorite Beta");
    const betaSelection = container.querySelector<HTMLElement>('[aria-label="Select Beta"]')!;
    await act(async () => {
      betaSelection.click();
    });
    await act(async () => {});
    const replacement = { ...b, id: "33333333-3333-4333-8333-333333333333" };
    await renderFleet(basePair({ preferenceScope: scope, onDeleteAgents: remove, agents: { [a.id]: a, [replacement.id]: replacement } }));
    expect(parseFleetPreferences(localStorage.getItem(scope)).favorites).toEqual([]);
    expect(favorite("Beta")?.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).not.toContain("1 selected");
  });

  it("isolates account/server scopes and rejects corrupt stored views", async () => {
    const scope = pairScope();
    await renderFleet(basePair({ preferenceScope: scope, onDeleteAgents: vi.fn() }));
    await clickButton("Favorite Alpha");
    await saveView("Private view");
    const selected = container.querySelector<HTMLElement>('[aria-label="Select Alpha"]')!;
    await act(async () => {
      selected.click();
    });
    await act(async () => {});
    const foreign = fleetPreferenceScope(fleetServerScope(), "user-b");
    await renderFleet(basePair({ preferenceScope: foreign, onDeleteAgents: vi.fn() }));
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).not.toContain("Private view");
    expect(container.textContent).not.toContain("1 selected");
    await clickButton("Favorite Beta");
    expect(parseFleetPreferences(localStorage.getItem(scope)).favorites).toEqual([a.id]);
    expect(parseFleetPreferences(localStorage.getItem(foreign)).favorites).toEqual([b.id]);
    const corrupt = fleetPreferenceScope("https://other.example/api/", "user-a");
    localStorage.setItem(corrupt, "{bad");
    await renderFleet(basePair({ preferenceScope: corrupt, onDeleteAgents: vi.fn() }));
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("false");
    await clickButton("Views");
    expect(document.body.textContent).toContain("No saved views yet.");
    await closeMenus();
  });

  it("keeps the verified account across a same-user focus re-check, and hides it for another account or session expiry", async () => {
    const agents = { [a.id]: a, [b.id]: b };
    await act(async () => {
      root.render(<ScopedFleet agents={agents} />);
    });
    await act(async () => {});
    await clickButton("Favorite Alpha");
    await saveView("Alice only");
    expect(api.me).toHaveBeenCalledTimes(1);
    let resolve!: (user: Awaited<ReturnType<typeof api.me>>) => void;
    vi.mocked(api.me).mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("true");
    expect(await viewListed("Alice only")).toBe(true);
    await act(async () => resolve({ id: "user-a", username: "alice", role: "admin" }));
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("true");
    expect(await viewListed("Alice only")).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => resolve({ id: "user-b", username: "bob", role: "admin" }));
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("false");
    expect(await viewListed("Alice only")).toBe(false);
    await act(async () => {
      notifySessionExpired();
    });
    expect(favorite("Alpha")?.disabled).toBe(true);
  });
});

describe("storage and server changes", () => {
  it("keeps blocked-storage preferences usable for this session without crossing scopes", async () => {
    const sessionScope = fleetPreferenceScope(fleetServerScope(), "blocked-storage-user");
    const agents = { [a.id]: a, [b.id]: b };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    await renderFleet(makeProps({ agents, preferenceScope: sessionScope }));
    await clickButton("Favorite Alpha");
    await saveView("Session view");
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(sessionScope)).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderFleet(makeProps({ agents, preferenceScope: sessionScope }));
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("true");
    expect(await viewListed("Session view")).toBe(true);
    await renderFleet(
      makeProps({ agents, preferenceScope: fleetPreferenceScope(fleetServerScope(), "different-storage-user") }),
    );
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("false");
    expect(await viewListed("Session view")).toBe(false);
  });

  it("rechecks identity for a changed configured server and prunes the final device", async () => {
    const agents = { [a.id]: a, [b.id]: b };
    await act(async () => {
      root.render(<ScopedFleet agents={agents} />);
    });
    await act(async () => {});
    await clickButton("Favorite Alpha");
    await saveView("Server one");
    const scope = fleetPreferenceScope(fleetServerScope(), "user-a");
    await act(async () => {
      localStorage.setItem("vantyr-server-settings", JSON.stringify({ serverOrigin: "https://other.example" }));
      window.dispatchEvent(new StorageEvent("storage", { key: "vantyr-server-settings" }));
    });
    await act(async () => {});
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(favorite("Alpha")?.getAttribute("aria-pressed")).toBe("false");
    expect(await viewListed("Server one")).toBe(false);
    await clickButton("Favorite Alpha");
    const other = fleetPreferenceScope(fleetServerScope(), "user-a");
    await act(async () => {
      root.render(<ScopedFleet agents={{}} />);
    });
    await act(async () => {});
    expect(parseFleetPreferences(localStorage.getItem(other)).favorites).toEqual([]);
    expect(parseFleetPreferences(localStorage.getItem(scope)).favorites).toEqual([a.id]);
  });
});

describe("status tabs", () => {
  it("filters to offline devices through the Offline tab", async () => {
    await renderFleet(makeProps({ agents: { [a.id]: a, [b.id]: b } }));
    expect(favorite("Alpha")).not.toBeNull();
    expect(favorite("Beta")).not.toBeNull();
    await clickTab("Offline");
    expect(selectedTab()?.startsWith("Offline")).toBe(true);
    expect(favorite("Beta")).not.toBeNull();
    expect(favorite("Alpha")).toBeNull();
    await clickButton("Clear filters");
    expect(favorite("Alpha")).not.toBeNull();
    expect(favorite("Beta")).not.toBeNull();
  });
});

describe("offline truthfulness", () => {
  it("labels an offline device Offline without inventing app-rule data", async () => {
    await renderFleet(makeProps());
    expect(container.textContent).toContain("Offline");
    expect(container.textContent).not.toContain("Enabled app rules");
  });
});
