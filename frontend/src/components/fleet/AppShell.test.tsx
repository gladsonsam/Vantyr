// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "../../lib/types";
import type { NotificationItem } from "../../hooks/useNotifications";
import { AppShell, useMobileNavOpener } from "./AppShell";

// jsdom has no PointerEvent; Base UI buttons construct one on click.
if (typeof window !== "undefined" && typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (window as unknown as { PointerEvent?: unknown }).PointerEvent = MouseEvent;
}

let el: HTMLDivElement;
let root: Root;

const online: Agent = {
  id: "online", name: "Online PC", online: true, last_seen: "2026-01-01", first_seen: "2026-01-01",
  connected_at: null, last_connected_at: null, last_disconnected_at: null,
};
const offline: Agent = { ...online, id: "offline", name: "Offline PC", online: false };

const home = vi.fn();
const preferences = vi.fn();
const logout = vi.fn();
const openUsers = vi.fn();
const openActivityLog = vi.fn();
const dismiss = vi.fn();

function Probe() {
  const open = useMobileNavOpener();
  const location = useLocation();
  return (
    <>
      <span data-testid="opener">{open ? "has-opener" : "no-opener"}</span>
      <button type="button" onClick={() => open?.()}>
        Nested navigation opener
      </button>
      <output>{location.pathname}</output>
    </>
  );
}

function OutsideProbe() {
  const open = useMobileNavOpener();
  return <span data-testid="outside">{open ? "has-opener" : "no-opener"}</span>;
}

interface RenderOptions {
  currentUser?: { username: string; role: "admin" | "operator" | "viewer"; display_name?: string };
  notifications?: NotificationItem[];
  hideTopBar?: boolean;
  withUsers?: boolean;
}

async function renderShell(options: RenderOptions = {}) {
  const {
    currentUser = { username: "operator", role: "admin" },
    notifications = [],
    hideTopBar = false,
    withUsers = true,
  } = options;
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <AppShell
          title="Agents"
          currentUser={currentUser}
          onLogout={logout}
          onShowPreferences={preferences}
          onOpenUsers={withUsers ? openUsers : undefined}
          onOpenActivityLog={openActivityLog}
          notifications={notifications}
          onDismissNotification={dismiss}
          agents={[online, offline]}
          onSelectAgent={home}
          hideTopBar={hideTopBar}
        >
          <Probe />
        </AppShell>
      </MemoryRouter>,
    );
  });
  await act(async () => {});
}

function button(label: string) {
  return (
    el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    [...el.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label)!
  );
}

async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => {
    target!.click();
  });
  await act(async () => {});
}

async function clickMenuItem(label: string) {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(item, label).toBeDefined();
  await act(async () => {
    (item as HTMLElement).click();
  });
  await act(async () => {});
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  home.mockReset();
  preferences.mockReset();
  logout.mockReset();
  openUsers.mockReset();
  openActivityLog.mockReset();
  dismiss.mockReset();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      get matches() {
        return window.innerWidth < 768;
      },
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  );
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

it("persists sidebar collapse across mounts through localStorage", async () => {
  await renderShell();
  expect(el.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("expanded");
  expect(button("Collapse sidebar")).toBeDefined();
  await click("Collapse sidebar");
  expect(el.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  expect(localStorage.getItem("sidebar-collapsed")).toBe("true");
  expect(button("Expand sidebar")).toBeDefined();

  await act(async () => root.unmount());
  root = createRoot(el);
  await renderShell();
  // Stored "true" means collapsed (the key tracks the collapsed flag inversely).
  expect(el.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  await click("Expand sidebar");
  expect(el.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("expanded");
  expect(localStorage.getItem("sidebar-collapsed")).toBe("false");
});

it("starts collapsed when collapse was saved", async () => {
  localStorage.setItem("sidebar-collapsed", "true");
  await renderShell();
  expect(el.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  expect(button("Expand sidebar")).toBeDefined();
});

it("navigates with links, marks the current page, and shows the agent badge", async () => {
  await renderShell();
  const navLink = (path: string) => el.querySelector<HTMLAnchorElement>(`li a[href="${path}"]`)!;
  const agents = navLink("/");
  expect(agents.hasAttribute("data-active")).toBe(true);
  expect(el.textContent).toContain("1/2");
  const recall = navLink("/recall");
  await act(async () => {
    recall.click();
  });
  expect(el.querySelector("output")!.textContent).toBe("/recall");
  expect(navLink("/recall").hasAttribute("data-active")).toBe(true);
  expect(navLink("/").hasAttribute("data-active")).toBe(false);
  expect(navLink("/settings")).not.toBeNull();
  expect(navLink("/users")).not.toBeNull();
});

it("hides the users nav entry for non-admins", async () => {
  await renderShell({ currentUser: { username: "viewer", role: "viewer" } });
  expect(el.querySelector('li a[href="/recall"]')).toBeNull();
  expect(el.querySelector('li a[href="/users"]')).toBeNull();
  expect(el.querySelector('li a[href="/settings"]')).not.toBeNull();
});

it("shows the title once, as the page heading", async () => {
  await renderShell();
  expect(el.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
  expect(el.querySelectorAll("h1")).toHaveLength(1);
  expect(el.querySelector("h1")?.textContent).toBe("Agents");
});

it("uses semantic account actions that fire callbacks", async () => {
  await renderShell();
  await click("Account options");
  await clickMenuItem("Account settings");
  expect(preferences).toHaveBeenCalledOnce();
  await click("Account options");
  await clickMenuItem("User accounts");
  expect(openUsers).toHaveBeenCalledOnce();
  await click("Account options");
  await clickMenuItem("Log out");
  expect(logout).toHaveBeenCalledOnce();
});

it("hides user accounts for non-admins", async () => {
  await renderShell({ currentUser: { username: "operator", role: "operator" } });
  await click("Account options");
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((candidate) => candidate.textContent?.trim());
  expect(items).toContain("Account settings");
  expect(items).not.toContain("User accounts");
  expect(items).toContain("Log out");
});

it("renders notifications and dismisses them through the callback", async () => {
  const notifications: NotificationItem[] = [
    { id: "n1", type: "warning", header: "Agent offline", content: "Offline PC" },
  ];
  await renderShell({ notifications });
  expect(el.textContent).toContain("Agent offline");
  expect(el.textContent).toContain("Offline PC");
  await click("Dismiss");
  expect(dismiss).toHaveBeenCalledWith("n1");
});

it("provides a mobile nav opener inside the shell and null outside it", async () => {
  await renderShell();
  expect(el.querySelector('[data-testid="opener"]')!.textContent).toBe("has-opener");
  await act(async () => {
    root.render(
      <MemoryRouter>
        <OutsideProbe />
      </MemoryRouter>,
    );
  });
  expect(el.querySelector('[data-testid="outside"]')!.textContent).toBe("no-opener");
});
