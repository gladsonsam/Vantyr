// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@/api/types";
import { DashboardLayout } from "./DashboardLayout";
import { AgentsContext, type AgentsContextValue } from "./providers/useAgents";
import { NotificationsContext, type NotificationsValue } from "./providers/useNotifications";
import { SessionContext, type SessionContextValue } from "./providers/useSession";
import { usePageHeader } from "./usePageHeader";

let el: HTMLDivElement;
let root: Root;

const agent: Agent = {
  id: "pc-1", name: "Office PC", online: true, last_seen: "2026-01-01", first_seen: "2026-01-01",
  connected_at: null, last_connected_at: null, last_disconnected_at: null,
};
const admin = { id: "u1", username: "admin", role: "admin" } as const;
const session: SessionContextValue = {
  authenticated: true, user: admin, navUser: admin,
  refresh: async () => {}, completeLogin: () => {}, logout: async () => {},
};
const agents: AgentsContextValue = {
  agents: { [agent.id]: agent }, liveStatus: {}, agentInfo: {}, agentInfoReceivedAtMs: {}, initialized: true,
  setSelectedAgentId: () => {}, send: () => {}, refresh: async () => {},
};
const notifications = {
  notifications: [], removeNotification: () => {}, info: () => "", warning: () => "", error: () => "",
} as unknown as NotificationsValue;

function TitledPage({ title, hideTopBar }: { title: string; hideTopBar?: boolean }) {
  usePageHeader({ title, description: `${title} page`, hideTopBar });
  return <output>{useLocation().pathname}</output>;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionContext.Provider value={session}>
      <NotificationsContext.Provider value={notifications}>
        <AgentsContext.Provider value={agents}>{children}</AgentsContext.Provider>
      </NotificationsContext.Provider>
    </SessionContext.Provider>
  );
}

async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <Providers>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<DashboardLayout />}>
              <Route index element={<TitledPage title="Agents" />} />
              <Route path="/logs" element={<TitledPage title="Audit log" />} />
              <Route path="/agents/:agentId" element={<TitledPage title="Agent Details" hideTopBar />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </Providers>,
    );
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
  }));
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

it("keeps the shell mounted across navigation and shows each page's header", async () => {
  await renderAt("/");
  const sidebar = el.querySelector('[data-slot="sidebar"]');
  expect(sidebar).not.toBeNull();
  expect(el.querySelector("h1")?.textContent).toBe("Agents");
  expect(el.textContent).toContain("Agents page");

  await act(async () => {
    el.querySelector<HTMLAnchorElement>('li a[href="/logs"]')!.click();
  });
  expect(el.querySelector("output")?.textContent).toBe("/logs");
  expect(el.querySelector("h1")?.textContent).toBe("Audit log");
  // Same DOM node: the sidebar was not remounted.
  expect(el.querySelector('[data-slot="sidebar"]')).toBe(sidebar);
});

it("hides the shell header on pages that render their own", async () => {
  await renderAt("/agents/pc-1");
  expect(el.querySelector('[data-slot="sidebar"]')).not.toBeNull();
  expect(el.querySelector("h1")).toBeNull();
  // The fleet count shows on every page now that the shell is shared.
  expect(el.textContent).toContain("1/1");
});
