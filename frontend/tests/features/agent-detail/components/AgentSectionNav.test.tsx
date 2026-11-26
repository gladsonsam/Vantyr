import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { AgentSectionNav } from "@/features/agent-detail/components/AgentSectionNav";
import { TAB_KEYS, AGENT_TAB_META, type TabKey } from "@/features/agent-detail/lib/agentTabNav";

beforeAll(() => {
  // cmdk measures and scrolls its list; jsdom has neither.
  Object.assign(globalThis, {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => unmountForms());

const siblings = (label: string) =>
  document.querySelector(`[role="tablist"][aria-label="${label}"]`);
const tab = (list: Element, name: string) =>
  Array.from(list.querySelectorAll('[role="tab"]')).find((t) => t.textContent?.trim() === name)!;
const switcher = () =>
  document.querySelector<HTMLButtonElement>("nav[aria-label='Agent tools'] button")!;
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const optionNames = () => options().map((o) => o.querySelector("span")!.textContent);

async function openSwitcher() {
  await click(switcher());
  await act(async () => {});
}

describe("AgentSectionNav", () => {
  it("names the agent and the tool on the switcher button", async () => {
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="urls" onTabChange={vi.fn()} />,
    );
    expect(switcher().textContent).toContain("Front desk");
    expect(switcher().textContent).toContain("Websites");
  });

  it("shows the neighbouring tools with the current one selected", async () => {
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="recall" onTabChange={vi.fn()} />,
    );
    const row = siblings("Activity tools")!;
    expect(tab(row, "Recall").getAttribute("aria-selected")).toBe("true");
    expect(tab(row, "Timeline").getAttribute("aria-selected")).toBe("false");
  });

  it("selects Live desktop on its own for ?tab=live, instead of pretending it is the timeline", async () => {
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="live" onTabChange={vi.fn()} />,
    );
    const row = siblings("Activity tools")!;
    expect(tab(row, "Live desktop").getAttribute("aria-selected")).toBe("true");
    expect(tab(row, "Timeline").getAttribute("aria-selected")).toBe("false");
    expect(switcher().textContent).toContain("Live desktop");
  });

  it("hides the neighbour row for single-tool groups", async () => {
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="settings" onTabChange={vi.fn()} />,
    );
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(switcher().textContent).toContain("Settings");
  });

  it("changes tool from the neighbour row", async () => {
    const onTabChange = vi.fn();
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="urls" onTabChange={onTabChange} />,
    );
    await click(tab(siblings("Monitoring tools")!, "Keystrokes"));
    expect(onTabChange).toHaveBeenCalledWith("keys");
  });
});

describe("tool switcher", () => {
  it("lists all sixteen tools in their groups and marks the current one", async () => {
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="logs" onTabChange={vi.fn()} />,
    );
    await openSwitcher();
    expect(options()).toHaveLength(TAB_KEYS.length);
    expect(optionNames().sort()).toEqual(TAB_KEYS.map((k) => AGENT_TAB_META[k].label).sort());
    const headings = Array.from(document.querySelectorAll("[cmdk-group-heading]")).map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["Activity", "Monitoring", "Device", "Control", "Settings"]);
    const current = options().filter((o) => o.getAttribute("aria-current") === "true");
    expect(current.map((o) => o.querySelector("span")!.textContent)).toEqual(["Device logs"]);
  });

  it.each<[string, TabKey]>([
    ["urls", "urls"],
    ["typing", "keys"],
    ["script", "scripts"],
    ["debug", "logs"],
    ["screen", "live"],
    ["powershell", "scripts"],
  ])("finds the right tool when searching %s", async (query, expected) => {
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="activity" onTabChange={vi.fn()} />,
    );
    await openSwitcher();
    await typeInto(document.querySelector<HTMLInputElement>("[cmdk-input]")!, query);
    expect(optionNames()).toContain(AGENT_TAB_META[expected].label);
  });

  it("says so when nothing matches", async () => {
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="activity" onTabChange={vi.fn()} />,
    );
    await openSwitcher();
    await typeInto(document.querySelector<HTMLInputElement>("[cmdk-input]")!, "zzzzzz");
    expect(options()).toHaveLength(0);
    expect(document.body.textContent).toContain("No tool matches that.");
  });

  it("switches tool and closes", async () => {
    const onTabChange = vi.fn();
    await mountForm(
      <AgentSectionNav agentName="Front desk" activeTab="activity" onTabChange={onTabChange} />,
    );
    await openSwitcher();
    await click(options().find((o) => o.textContent?.includes("Terminal"))!);
    expect(onTabChange).toHaveBeenCalledWith("terminal");
    await act(async () => {});
    expect(document.querySelector('[role="option"]')).toBeNull();
  });
});
