import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";

/** How long after arriving a landing keeps correcting for content that grows in late. */
export const LANDING_SETTLE_MS = 2500;

interface ArrivalContext {
  tab: TabKey;
  /** `?scroll=activity` asks for the tool bar at the top, as the palette and the Agents list do. */
  scrollRequested: boolean;
  /** `?at=` points at a moment; the Timeline scrolls to that moment itself. */
  hasMoment: boolean;
  /** The first view of this agent: the default entry shows the live desktop. */
  firstArrival: boolean;
}

/**
 * Whether an address, reload or history step that was not a click should land on the tool.
 * Clicks always land. The default entry (Timeline, Live desktop) keeps showing the desktop on top
 * unless the address asks for the tool, and a Timeline moment is scrolled to by the Timeline.
 */
export function shouldLandOnArrival({
  tab,
  scrollRequested,
  hasMoment,
  firstArrival,
}: ArrivalContext): boolean {
  if (tab === "live") return !firstArrival;
  if (tab === "activity") return scrollRequested && !hasMoment;
  return true;
}

function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** The shell's frame clips with overflow hidden; scrollIntoView would nudge it too and push the whole app up. */
function resetClippedAncestors(from: HTMLElement): void {
  for (let node = from.parentElement; node; node = node.parentElement) {
    if (node.scrollTop > 0 && getComputedStyle(node).overflowY === "hidden") node.scrollTop = 0;
  }
}

/** Scrolls so the tool's content starts just under the pinned bar (the top of the page for Live desktop). */
export function landOnTool(root: HTMLElement, tab: TabKey): void {
  const scroller = scrollParentOf(root);
  if (!scroller) return;
  resetClippedAncestors(scroller);
  if (tab === "live") {
    scroller.scrollTop = 0;
    return;
  }
  const bar = root.querySelector<HTMLElement>(".agent-detail-section-tabs");
  const content = root.querySelector<HTMLElement>("[data-agent-tool-content]");
  if (!bar || !content) return;
  scroller.scrollTop +=
    content.getBoundingClientRect().top - (scroller.getBoundingClientRect().top + bar.offsetHeight);
}

function isOffTarget(root: HTMLElement): boolean {
  const bar = root.querySelector<HTMLElement>(".agent-detail-section-tabs");
  const content = root.querySelector<HTMLElement>("[data-agent-tool-content]");
  if (!bar || !content) return false;
  const top = (scrollParentOf(root)?.getBoundingClientRect().top ?? 0) + bar.offsetHeight;
  return Math.abs(content.getBoundingClientRect().top - top) > 2;
}

const INTERRUPTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * After landing, content above or below can still change size (the desktop placeholder, a list
 * that finishes loading). Re-land when that moved the tool, until the person scrolls or touches
 * the page or the settle time is up. Returns a function that stops watching.
 */
export function keepOnTool(
  root: HTMLElement,
  tab: TabKey,
  durationMs = LANDING_SETTLE_MS,
): () => void {
  if (tab === "live" || typeof ResizeObserver === "undefined") return () => undefined;
  const observer = new ResizeObserver(() => {
    if (isOffTarget(root)) landOnTool(root, tab);
  });
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    for (const type of INTERRUPTS) window.removeEventListener(type, stop, true);
  };
  const timer = window.setTimeout(stop, durationMs);
  for (const type of INTERRUPTS)
    window.addEventListener(type, stop, { capture: true, passive: true });
  observer.observe(root);
  return stop;
}
