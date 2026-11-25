import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { click } from "@tests/support/formDom";

/** DOM helpers for tests that mount a whole Rules tab (no testing-library in this repo). */
export function createTabHarness() {
  let host: HTMLDivElement;
  let root: Root;

  return {
    setup() {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    },
    async teardown() {
      await act(async () => root.unmount());
      host.remove();
      document.body.innerHTML = "";
    },
    get host() {
      return host;
    },
    async render(node: ReactNode) {
      await act(async () => root.render(withQueryClient(<MemoryRouter>{node}</MemoryRouter>, createTestQueryClient())));
    },
    items: (label: string) => [...host.querySelectorAll(`ul[aria-label="${label}"] > li`)] as HTMLElement[],
    btn: (name: string, scope: ParentNode = document) =>
      [...scope.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim() === name) as HTMLButtonElement | undefined,
    dialog: () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
    menuItem: (name: string) => [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim().startsWith(name)) as HTMLElement,
    async openMenu(title: string) {
      const trigger = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === `More actions for ${title}`)!;
      await click(trigger);
      await act(async () => {});
    },
    switchOf: (item: HTMLElement) => item.querySelector<HTMLElement>('[role="switch"]')!,
  };
}
