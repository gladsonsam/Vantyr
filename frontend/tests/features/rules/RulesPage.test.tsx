import { click } from "@tests/support/formDom";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

await vi.mock("@/api", () => ({
  api: {
    agentGroupsList: vi.fn(async () => ({ groups: [] })),
    agentsOverview: vi.fn(async () => ({ agents: [] })),
  },
  errorText: String,
}));
// Each destination has its own tests; here only the page's navigation is under test.
await vi.mock("@/features/rules/AlertRulesTab", () => ({
  AlertRulesTab: () => <p>alert rules content</p>,
}));
await vi.mock("@/features/rules/AppBlockingTab", () => ({
  AppBlockingTab: () => <p>app blocking content</p>,
}));
await vi.mock("@/features/rules/InternetAccessTab", () => ({
  InternetAccessTab: () => <p>internet content</p>,
}));
await vi.mock("@/features/rules/ScheduledScriptsTab", () => ({
  ScheduledScriptsTab: () => <p>scripts content</p>,
}));
await vi.mock("@/features/rules/EventsGlobalTab", () => ({
  EventsGlobalTab: () => <p>events content</p>,
}));

const { RulesPage } = await import("@/features/rules/RulesPage");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

function Where() {
  return <output data-testid="where">{useLocation().search}</output>;
}
async function render(url: string) {
  await act(async () =>
    root.render(
      withQueryClient(
        <MemoryRouter initialEntries={[url]}>
          <RulesPage />
          <Where />
        </MemoryRouter>,
        createTestQueryClient(),
      ),
    ),
  );
}
const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
const selected = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent;

describe("RulesPage navigation", () => {
  it("opens on Alerts and offers all five destinations with a one-line caption for the open one", async () => {
    await render("/rules");
    expect(tabs().map((t) => t.textContent)).toEqual([
      "Alerts",
      "App blocking",
      "Internet",
      "Scripts",
      "Events",
    ]);
    expect(selected()).toBe("Alerts");
    expect(host.textContent).toContain("alert rules content");
    expect(host.textContent).toContain("Get an alert when an agent visits a site");
  });

  it.each([
    ["alert-rules", "Alerts"],
    ["app-blocking", "App blocking"],
    ["internet-access", "Internet"],
    ["scheduled-scripts", "Scripts"],
    ["events", "Events"],
  ])("keeps the saved link ?tab=%s opening %s", async (id, label) => {
    await render(`/rules?tab=${id}`);
    expect(selected()).toBe(label);
  });

  it("falls back to Alerts for an unknown tab", async () => {
    await render("/rules?tab=nope");
    expect(selected()).toBe("Alerts");
  });

  it("switching destination updates the address and the caption, and keeps other parameters", async () => {
    await render("/rules?x=1");
    await click(tabs().find((t) => t.textContent === "Internet")!);
    expect(host.querySelector('[data-testid="where"]')?.textContent).toBe(
      "?x=1&tab=internet-access",
    );
    expect(selected()).toBe("Internet");
    expect(host.textContent).toContain("Cut internet access for agents or groups");
  });
});
