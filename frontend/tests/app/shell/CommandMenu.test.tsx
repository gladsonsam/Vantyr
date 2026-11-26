// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Globe, Settings } from "lucide-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@/api/types";
import { CommandMenu, type CommandTool } from "@/app/shell/CommandMenu";

if (typeof window !== "undefined" && typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (window as unknown as { PointerEvent?: unknown }).PointerEvent = MouseEvent;
}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let el: HTMLDivElement;
let root: Root;

const agent = (id: string, name: string, online: boolean): Agent => ({
  id, name, online, last_seen: "2026-01-01", first_seen: "2026-01-01", icon: null, agent_version: null,
  connected_at: null, last_connected_at: null, last_disconnected_at: null,
});

beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});

async function render(tools?: { heading: string; items: CommandTool[] }) {
  const onSelectAgent = vi.fn();
  const onOpenChange = vi.fn();
  await act(async () => {
    root.render(
      <CommandMenu
        open
        onOpenChange={onOpenChange}
        pages={[{ label: "Rules", icon: Settings, onSelect: vi.fn() }]}
        tools={tools}
        agents={[agent("a", "Front desk", true), agent("b", "Lobby kiosk", false)]}
        onSelectAgent={onSelectAgent}
      />,
    );
  });
  return { onSelectAgent, onOpenChange };
}

const text = () => document.body.textContent ?? "";
const option = (label: string) =>
  [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(label)) as HTMLElement | undefined;

it("says only the exception for device status: offline is spelled out, online is screen-reader text", async () => {
  await render();
  expect(option("Lobby kiosk")?.textContent).toContain("offline");
  expect(option("Front desk")?.querySelector(".sr-only")?.textContent).toBe("online");
  expect(document.querySelector("input")?.getAttribute("placeholder")).toBe("Search pages and devices…");
});

it("lists the open device's tools first with their hints and runs the chosen one", async () => {
  const onSelect = vi.fn();
  await render({
    heading: "Tools · Front desk",
    items: [
      { id: "urls", label: "Websites", hint: "Pages visited, with categories", icon: Globe, onSelect },
      { id: "settings", label: "Settings", hint: "Modules and removal", icon: Settings, onSelect: vi.fn() },
      { id: "recall", label: "Recall", hint: "Replay what was on screen", icon: Settings, onSelect: vi.fn() },
    ],
  });
  expect(text()).toContain("Tools · Front desk");
  expect(document.querySelector("input")?.getAttribute("placeholder")).toBe("Search tools, pages and devices…");
  const groups = [...document.querySelectorAll("[cmdk-group-heading]")].map((g) => g.textContent);
  expect(groups).toEqual(["Tools · Front desk", "Devices", "Pages"]);
  expect(option("Websites")?.textContent).toContain("Pages visited, with categories");
  await act(async () => {
    option("Websites")!.click();
  });
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("hides the tools group when no device is open", async () => {
  await render(undefined);
  expect([...document.querySelectorAll("[cmdk-group-heading]")].map((g) => g.textContent)).toEqual(["Devices", "Pages"]);
});

it("finds tools by whole words like the in-page switcher and does not fuzzy-match unrelated ones", async () => {
  await render({
    heading: "Tools · Front desk",
    items: [
      { id: "logs", label: "Device logs", hint: "Log output from the agent", icon: Globe, onSelect: vi.fn() },
      { id: "recall", label: "Recall", hint: "Replay what was on screen", icon: Globe, onSelect: vi.fn() },
      { id: "settings", label: "Settings", hint: "Modules and removal", icon: Settings, onSelect: vi.fn() },
    ],
  });
  const input = document.querySelector("input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "logs");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const labels = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  expect(labels).toHaveLength(1);
  expect(labels[0]).toContain("Device logs");
});

function chord(init: KeyboardEventInit = {}, prevent = false) {
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true, ...init });
  if (prevent) document.body.addEventListener("keydown", e => e.preventDefault(), { once: true });
  act(() => { document.body.dispatchEvent(event); });
}
async function renderClosed() {
  const onOpenChange = vi.fn();
  await act(async () => { root.render(<CommandMenu open={false} onOpenChange={onOpenChange} pages={[]} />); });
  return onOpenChange;
}

it("opens on Ctrl+K and ⌘K", async () => {
  const onOpenChange = await renderClosed();
  chord(); chord({ ctrlKey: false, metaKey: true });
  expect(onOpenChange).toHaveBeenCalledTimes(2);
});
it("leaves Ctrl+K alone when a focused surface already handled it", async () => {
  const onOpenChange = await renderClosed();
  chord({}, true);
  expect(onOpenChange).not.toHaveBeenCalled();
});
it("does not open behind a fullscreen element it cannot show", async () => {
  const onOpenChange = await renderClosed();
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.body });
  try { chord(); } finally { Reflect.deleteProperty(document, "fullscreenElement"); }
  expect(onOpenChange).not.toHaveBeenCalled();
});
