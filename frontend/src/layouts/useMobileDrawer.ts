import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export const MOBILE_NAV_QUERY = "(max-width: 768px)";
export function useMobileViewport() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_NAV_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_NAV_QUERY);
    const update = () => setMobile(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

/** The sidebar is a modal only on mobile; restore focus after removing inertness. */
export function useMobileDrawer(open: boolean, drawer: RefObject<HTMLElement | null>, background: RefObject<HTMLElement | null>, opener: RefObject<HTMLElement | null>, close: () => void) {
  useLayoutEffect(() => {
    if (!open || !drawer.current) return;
    const panel = drawer.current;
    const trigger = opener.current;
    const fallback = background.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]')]
      .filter(el => el.tabIndex >= 0 && !el.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
    const first = () => focusable()[0] ?? panel;
    first().focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      const current = document.activeElement;
      if (!items.length) { event.preventDefault(); panel.focus(); }
      else if (event.shiftKey && (current === items[0] || !panel.contains(current))) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && (current === items[items.length - 1] || !panel.contains(current))) { event.preventDefault(); items[0].focus(); }
    };
    const containFocus = (event: FocusEvent) => { if (!panel.contains(event.target as Node)) first().focus(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", containFocus);
      // React has removed background inertness before this queued restoration.
      queueMicrotask(() => {
        const target = trigger;
        const hiddenMobileTrigger = target?.classList.contains("mobile-menu-toggle") && !window.matchMedia(MOBILE_NAV_QUERY).matches;
        if (target?.isConnected && !hiddenMobileTrigger && !target.closest('[hidden], [inert]')) target.focus();
        else if (fallback?.isConnected) fallback.focus();
      });
    };
  }, [open, drawer, background, opener, close]);
}

/** Use the visual viewport when a software keyboard reduces the visible height. */
export function useDashboardViewport(shell: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      shell.current?.style.setProperty("--dashboard-viewport-height", `${viewport.height}px`);
      shell.current?.style.setProperty("--dashboard-viewport-top", `${viewport.offsetTop}px`);
    };
    update(); viewport.addEventListener("resize", update); viewport.addEventListener("scroll", update);
    return () => { viewport.removeEventListener("resize", update); viewport.removeEventListener("scroll", update); };
  }, [shell]);
}
