import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";
import {
  keepOnTool,
  landOnTool,
  shouldLandOnArrival,
} from "@/features/agent-detail/lib/toolLanding";

interface UseToolLandingOptions {
  rootRef: RefObject<HTMLElement | null>;
  agentId: string;
  activeTab: TabKey;
  scrollRequested: boolean;
  hasMoment: boolean;
}

/**
 * Makes every way of reaching a tool land on it with the pinned bar in view: a click, a pasted or
 * reloaded address, browser back/forward and the palette. One landing per arrival, so a click and
 * the address change it causes never scroll twice.
 */
export function useToolLanding({
  rootRef,
  agentId,
  activeTab,
  scrollRequested,
  hasMoment,
}: UseToolLandingOptions) {
  const clickedRef = useRef<TabKey | null>(null);
  const arrivedAgentRef = useRef<string | null>(null);
  const hasMomentRef = useRef(hasMoment);
  const stopRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    hasMomentRef.current = hasMoment;
  }, [hasMoment]);

  const land = useCallback(
    (tab: TabKey, settle: boolean) => {
      stopRef.current();
      const frame = requestAnimationFrame(() => {
        const root = rootRef.current;
        if (!root) return;
        landOnTool(root, tab);
        stopRef.current = settle ? keepOnTool(root, tab) : () => undefined;
      });
      stopRef.current = () => cancelAnimationFrame(frame);
    },
    [rootRef],
  );

  useEffect(() => {
    const firstArrival = arrivedAgentRef.current !== agentId;
    arrivedAgentRef.current = agentId;
    const clicked = clickedRef.current === activeTab;
    clickedRef.current = null;
    if (clicked) land(activeTab, false);
    else if (
      shouldLandOnArrival({
        tab: activeTab,
        scrollRequested,
        hasMoment: hasMomentRef.current,
        firstArrival,
      })
    )
      land(activeTab, true);
    return () => stopRef.current();
  }, [agentId, activeTab, scrollRequested, land]);

  /** Call when the person picks a tool; `onChange` updates the address. */
  return useCallback(
    (tab: TabKey, onChange: (tab: TabKey) => void) => {
      clickedRef.current = tab;
      onChange(tab);
      // Picking the tool already open changes nothing in the address, so land right here.
      if (tab === activeTab) {
        clickedRef.current = null;
        land(tab, false);
      }
    },
    [activeTab, land],
  );
}
