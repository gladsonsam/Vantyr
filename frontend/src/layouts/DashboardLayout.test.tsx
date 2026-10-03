import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardLayout, useMobileNavOpener } from "./DashboardLayout";
let el: HTMLDivElement, root: Root, mobile = true;
const listeners = new Set<() => void>();
const home = vi.fn(), preferences = vi.fn(), logout = vi.fn();
function Content() { const open = useMobileNavOpener(); const location = useLocation(); return <><button onClick={() => open?.()}>Nested navigation opener</button><button>Background action</button><output>{location.pathname}</output></>; }
const button = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...el.querySelectorAll("button")].find(b => b.textContent === label)!;
async function click(label: string) { await act(async () => { const target = button(label); target.focus(); target.click(); }); }
function key(key: string, shiftKey = false) { act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {key, shiftKey, bubbles: true, cancelable: true}))); }
async function resize(next: boolean) { await act(async () => { mobile = next; listeners.forEach(listener => listener()); }); }
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  mobile = true; listeners.clear(); localStorage.clear(); home.mockReset(); preferences.mockReset(); logout.mockReset();
  vi.stubGlobal("matchMedia", () => ({get matches() {return mobile;}, addEventListener: (_type: string, cb: () => void) => listeners.add(cb), removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb)}));
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); vi.unstubAllGlobals(); document.body.style.overflow = ""; });
async function render(hideTopBar = false) {
  await act(async () => root.render(<MemoryRouter><DashboardLayout hideTopBar={hideTopBar} content={<Content />} onGoHome={home} onLogout={logout} onShowPreferences={preferences} onOpenActivityLog={() => {}} currentUser={{username: "operator", role: "admin"}} notifications={[]} onDismissNotification={() => {}} /></MemoryRouter>));
}
it("opens a labelled modal, contains keyboard and programmatic focus, and restores the opener on Escape", async () => {
  document.body.style.overflow = "auto"; await render();
  const sidebar = el.querySelector<HTMLElement>("aside")!;
  expect(sidebar.hidden).toBe(true); expect(sidebar.hasAttribute("inert")).toBe(true);
  await click("Open navigation");
  expect(sidebar.getAttribute("role")).toBe("dialog"); expect(sidebar.getAttribute("aria-modal")).toBe("true");
  expect(el.querySelector(".dashboard-main")!.hasAttribute("inert")).toBe(true); expect(document.body.style.overflow).toBe("hidden");
  expect(document.activeElement).toBe(button("Close navigation"));
  key("Tab", true); expect(document.activeElement?.textContent).toBe("Server settings");
  key("Tab"); expect(document.activeElement).toBe(button("Close navigation"));
  act(() => button("Background action").focus()); expect(sidebar.contains(document.activeElement)).toBe(true);
  await act(async () => key("Escape"));
  expect(sidebar.hidden).toBe(true); expect(document.activeElement).toBe(button("Open navigation"));
  expect(el.querySelector(".dashboard-main")!.hasAttribute("inert")).toBe(false); expect(document.body.style.overflow).toBe("auto");
});
it("navigates with links and closes even when selecting the current route", async () => {
  await render(); await click("Open navigation");
  const agents = el.querySelector<HTMLAnchorElement>('a[href="/"]')!;
  expect(agents.getAttribute("aria-current")).toBe("page");
  await act(async () => agents.click()); expect(home).toHaveBeenCalledOnce(); expect(el.querySelector<HTMLElement>("aside")!.hidden).toBe(true);
  await click("Open navigation"); await act(async () => el.querySelector<HTMLAnchorElement>('a[href="/recall"]')!.click());
  expect(el.querySelector("output")!.textContent).toBe("/recall"); expect(el.querySelector<HTMLElement>("aside")!.hidden).toBe(true);
  expect(document.activeElement).toBe(button("Open navigation"));
});
it("restores nested openers, closes by button and backdrop, and closes on desktop resize", async () => {
  await render(true); await click("Nested navigation opener"); await click("Close navigation");
  expect(document.activeElement).toBe(button("Nested navigation opener"));
  await click("Nested navigation opener"); await act(async () => el.querySelector<HTMLElement>(".dashboard-mobile-backdrop")!.click());
  expect(el.querySelector<HTMLElement>("aside")!.hidden).toBe(true);
  await click("Nested navigation opener"); await resize(false);
  expect(el.querySelector('[role="dialog"]')).toBeNull(); expect(el.querySelector(".dashboard-mobile-backdrop")).toBeNull();
  expect(document.activeElement).toBe(button("Nested navigation opener"));
  await resize(true); expect(el.querySelector<HTMLElement>("aside")!.hidden).toBe(true);
});
it("keeps labels on mobile when desktop collapse is saved, then restores desktop preference", async () => {
  localStorage.setItem("sidebar-collapsed", "true"); await render(); await click("Open navigation");
  expect(el.querySelector('a[href="/recall"]')!.textContent).toBe("Recall"); expect(button("Expand sidebar").hidden).toBe(true);
  await resize(false); expect(el.querySelector('a[href="/recall"]')!.textContent).toBe("");
  expect(document.activeElement).toBe(el.querySelector(".dashboard-main"));
  await click("Expand sidebar"); expect(el.querySelector('a[href="/recall"]')!.textContent).toBe("Recall");
  expect(localStorage.getItem("sidebar-collapsed")).toBe("false");
});
it("uses semantic account actions that work from the keyboard", async () => {
  await render(); await click("Account options"); expect(button("Account settings").tagName).toBe("BUTTON");
  await click("Account settings"); expect(preferences).toHaveBeenCalledOnce();
  await click("Account options"); await click("Logout"); expect(logout).toHaveBeenCalledOnce();
});
it("ignores mobile opener calls on desktop so resizing cannot resurrect an unopened drawer", async () => {
  mobile = false; await render(true); await click("Nested navigation opener");
  expect(el.querySelector('[role="dialog"]')).toBeNull();
  await resize(true); expect(el.querySelector<HTMLElement>("aside")!.hidden).toBe(true);
});
