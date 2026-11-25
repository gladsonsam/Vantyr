// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click, typeInto } from "@tests/support/formDom";
import { AgentsContext, type AgentsContextValue } from "@/app/providers/useAgents";
import { AuditTab } from "@/features/logs/AuditTab";

const api = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e instanceof Error ? e.message : e), apiUrl: (p: string) => p }));

const record = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  ts: new Date(Date.UTC(2026, 10, 1, 0, id)).toISOString(),
  actor: "admin",
  client_ip: "10.0.0.5",
  agent_id: null,
  action: "run_script",
  status: "ok",
  detail: {},
  ...patch,
});

const agents = { a1: { id: "a1", name: "Alpha" } } as unknown as AgentsContextValue["agents"];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function render(props: Parameters<typeof AuditTab>[0] = {}) {
  await act(async () =>
    root.render(
      withQueryClient(
        <MemoryRouter>
          <AgentsContext.Provider value={{ agents } as AgentsContextValue}>
            <AuditTab {...props} />
          </AgentsContext.Provider>
        </MemoryRouter>,
        createTestQueryClient(),
      ),
    ),
  );
}
const items = () => [...host.querySelectorAll("li")];
const status = () => host.querySelector('[role="status"]')?.textContent;
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim().startsWith(name)) as HTMLButtonElement;
const search = () => host.querySelector<HTMLInputElement>('input[aria-label="Search audit log"]')!;

describe("AuditTab", () => {
  it("lists actions newest first with outcome, who, where from and the device, hiding page views", async () => {
    api.audit.mockResolvedValue({
      rows: [
        record(3, { action: "update_internet_policy", status: "error", agent_id: "a1", actor: "operator", detail: { error: "device offline" } }),
        record(2, { action: "view_windows", agent_id: "a1" }),
        record(1, { action: "login", actor: "auth", client_ip: null }),
      ],
    });
    await render();
    expect(api.audit).toHaveBeenCalledWith({ limit: 500, agent_id: undefined, status: undefined });
    const rows = items();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Update Internet Block");
    expect(rows[0].textContent).toContain("Failed");
    expect(rows[0].textContent).toContain("operator");
    expect(rows[0].textContent).toContain("10.0.0.5");
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("/agents/a1");
    expect(rows[0].querySelector("a")?.textContent).toBe("Alpha");
    expect(rows[1].textContent).toContain("Login");
    expect(rows[1].textContent).toContain("Succeeded");
    expect(status()).toBe("2 records · 1 page view hidden");
  });

  it("shows page views when asked and says when only page views exist", async () => {
    api.audit.mockResolvedValue({ rows: [record(1, { action: "view_urls" })] });
    await render();
    expect(items()).toHaveLength(0);
    expect(host.textContent).toContain("Only page views recorded");
    await click(button("Show page views") as HTMLElement);
    expect(items()).toHaveLength(1);
    expect(host.textContent).toContain("View URLs");
  });

  it("opens a row's detail with the raw record, announcing the state and keeping focus on the button", async () => {
    api.audit.mockResolvedValue({
      rows: [record(7, { action: "run_command", status: "error", detail: { cmd_type: "ListDir", error: '{"message":"module not authorized"}' } })],
    });
    await render();
    const toggle = items()[0].querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.textContent).toContain("Command ListDir");
    expect(toggle.textContent).toContain("Error module not authorized");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeNull();
    toggle.focus();
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel.textContent).toContain("#7");
    expect(panel.querySelector("pre")?.textContent).toContain('"cmd_type": "ListDir"');
    expect(document.activeElement).toBe(toggle);
    await click(toggle);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeNull();
  });

  it("gives records with no detail no disclosure", async () => {
    api.audit.mockResolvedValue({ rows: [record(1, { detail: { limit: 50, offset: 0 } })] });
    await render();
    expect(items()[0].querySelector("button")).toBeNull();
  });

  it("searches every word across action, user, device and detail, and explains a miss", async () => {
    api.audit.mockResolvedValue({
      rows: [record(2, { agent_id: "a1", detail: { target: "kiosk" } }), record(1, { action: "login", actor: "auth", client_ip: null })],
    });
    await render();
    await typeInto(search(), "run alpha");
    expect(items()).toHaveLength(1);
    expect(status()).toBe("1 of 2 records");
    await typeInto(search(), "nothing like this");
    expect(items()).toHaveLength(0);
    expect(host.textContent).toContain("Nothing matches “nothing like this”");
    expect(status()).toBe("No matches");
    await click(button("Clear search"));
    expect(items()).toHaveLength(2);
  });

  it("drops the user from every row when one person did everything, and says so once", async () => {
    api.audit.mockResolvedValue({ rows: [record(2), record(1)] });
    await render();
    expect(status()).toBe("2 records · all by admin");
    expect(items()[0].textContent).not.toContain("admin");
  });

  it("groups by day and flips to oldest first", async () => {
    api.audit.mockResolvedValue({
      rows: [record(2, { ts: "2026-11-02T09:00:00Z", action: "power_action" }), record(1, { ts: "2026-10-30T09:00:00Z", action: "run_script" })],
    });
    await render();
    expect(host.querySelectorAll("h3")).toHaveLength(2);
    expect(items()[0].textContent).toContain("Trigger Power Action");
    await click(button("Newest first"));
    expect(items()[0].textContent).toContain("Run Script");
    expect(button("Oldest first").textContent).toContain("Oldest");
  });

  it("pages fifty at a time with a range in the status line, and a new search starts again at page 1", async () => {
    api.audit.mockResolvedValue({ rows: Array.from({ length: 60 }, (_, i) => record(60 - i, { actor: i % 2 ? "admin" : "operator" })) });
    await render();
    expect(items()).toHaveLength(50);
    expect(status()).toBe("1–50 of 60");
    await click(button("Next page"));
    expect(items()).toHaveLength(10);
    expect(status()).toBe("51–60 of 60");
    await typeInto(search(), "operator");
    expect(items()).toHaveLength(30);
    expect(status()).toBe("30 of 60 records · all by operator");
    await typeInto(search(), "");
    expect(status()).toBe("1–50 of 60");
  });

  it("qualifies a list that reached the load limit", async () => {
    api.audit.mockResolvedValue({ rows: Array.from({ length: 500 }, (_, i) => record(500 - i)) });
    await render();
    expect(status()).toContain("newest 500 loaded, older ones may exist");
  });

  it("explains an empty log", async () => {
    api.audit.mockResolvedValue({ rows: [] });
    await render();
    expect(host.textContent).toContain("No audit records yet");
    expect(status()).toBe("No records");
  });

  it("names a scope that has nothing in it", async () => {
    api.audit.mockResolvedValue({ rows: [record(1)] });
    await render({ scope: "auth" });
    expect(host.textContent).toContain("No sign-in records");
    expect(host.textContent).toContain("None among the 1 loaded records.");
  });

  it("asks for one device's records and leaves the device column out", async () => {
    api.audit.mockResolvedValue({ rows: [record(1, { agent_id: "a1" })] });
    await render({ agentId: "a1" });
    expect(api.audit).toHaveBeenCalledWith({ limit: 500, agent_id: "a1", status: undefined });
    expect(items()[0].querySelector("a")).toBeNull();
  });

  it("reports a failed first load with a way to retry, not an empty log", async () => {
    api.audit.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ rows: [record(1)] });
    await render();
    expect(host.textContent).toContain("Couldn’t load the audit log: boom");
    expect(host.textContent).not.toContain("No audit records yet");
    expect(status()).toBe("Audit log unavailable");
    expect(search()).not.toBeNull();
    await click(button("Try again"));
    expect(items()).toHaveLength(1);
  });

  it("keeps the records on screen when a refresh fails and says so", async () => {
    api.audit.mockResolvedValueOnce({ rows: [record(1)] }).mockRejectedValueOnce(new Error("offline"));
    await render();
    await click(button("Refresh audit log"));
    expect(items()).toHaveLength(1);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t refresh the audit log: offline");
    expect(alert?.textContent).toContain("last successful load");
  });
});
