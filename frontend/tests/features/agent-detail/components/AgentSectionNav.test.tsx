// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mountForm, unmountForms } from "@tests/support/formDom";
import { AgentSectionNav } from "@/features/agent-detail/components/AgentSectionNav";

function stubViewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: wide, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

afterEach(() => {
  unmountForms();
  vi.unstubAllGlobals();
});

const tablist = (label: string) => document.querySelector(`[role="tablist"][aria-label="${label}"]`);
const tab = (list: Element, name: string) => Array.from(list.querySelectorAll('[role="tab"]')).find((t) => t.textContent?.trim() === name)!;

describe("AgentSectionNav", () => {
  it("keeps the section's pages inside the pinned bar when the viewport is wide", async () => {
    stubViewport(true);
    await mountForm(<AgentSectionNav activeTab="activity" onTabChange={vi.fn()} />);
    const pinned = document.querySelector(".agent-detail-section-tabs")!;
    expect(pinned.contains(tablist("Section pages"))).toBe(true);
    expect(tab(tablist("Section pages")!, "Timeline").getAttribute("aria-selected")).toBe("true");
  });

  it("puts the pages on their own row below the bar on narrower viewports", async () => {
    stubViewport(false);
    await mountForm(<AgentSectionNav activeTab="recall" onTabChange={vi.fn()} />);
    expect(document.querySelector(".agent-detail-section-tabs")!.contains(tablist("Section pages"))).toBe(false);
    expect(tablist("Section pages")).not.toBeNull();
    expect(tab(tablist("Agent sections")!, "Activity").getAttribute("aria-selected")).toBe("true");
  });

  it("opens a section on its first page and hides the page row for single-page sections", async () => {
    stubViewport(false);
    const onTabChange = vi.fn();
    await mountForm(<AgentSectionNav activeTab="activity" onTabChange={onTabChange} />);
    await click(tab(tablist("Agent sections")!, "Telemetry"));
    expect(onTabChange).toHaveBeenCalledWith("urls");
    unmountForms();
    await mountForm(<AgentSectionNav activeTab="settings" onTabChange={onTabChange} />);
    expect(tablist("Section pages")).toBeNull();
  });
});
