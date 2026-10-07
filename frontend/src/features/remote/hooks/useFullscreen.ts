import { useEffect, useState, type RefObject } from "react";
import { exitViewportFullscreen, requestViewportFullscreen } from "@/features/remote/lib/fullscreen";

/**
 * Maximizing the live screen: native fullscreen where the browser allows it for a <div>,
 * otherwise (touch / iOS) a CSS fixed overlay ("pseudo fullscreen") that locks page scroll and
 * exits on Escape. Leaves either mode when the live view turns off.
 */
export function useFullscreen(containerRef: RefObject<HTMLDivElement | null>, streamEnabled: boolean) {
  const [fullscreen, setFullscreen] = useState(false);
  /** CSS-overlay "maximize" for touch/iOS where the Fullscreen API can't target a <div>. */
  const [pseudoFs, setPseudoFs] = useState(false);

  useEffect(() => {
    if (!streamEnabled) {
      setPseudoFs(false);
      const wrap = containerRef.current;
      if (wrap && document.fullscreenElement === wrap) {
        void document.exitFullscreen();
      }
    }
  }, [streamEnabled, containerRef]);

  // Pseudo-fullscreen (CSS overlay): lock body scroll and allow Escape/back to exit,
  // since the native `fullscreenchange` event won't fire for this path.
  useEffect(() => {
    if (!pseudoFs) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setPseudoFs(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [pseudoFs]);

  const toggle = (beforeToggle: () => void) => {
    const el = containerRef.current;
    if (!el) return;

    const coarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const canNativeFs =
      typeof el.requestFullscreen === "function" &&
      document.fullscreenEnabled !== false &&
      !coarsePointer;

    if (pseudoFs) { setPseudoFs(false); return; }
    beforeToggle();
    if (canNativeFs) {
      if (!document.fullscreenElement) {
        void requestViewportFullscreen(el).catch(() => setPseudoFs(true));
      } else {
        void exitViewportFullscreen();
      }
    } else {
      // iOS Safari / touch devices: the Fullscreen API can't target a <div>,
      // so fall back to a CSS fixed-overlay "maximize".
      setPseudoFs((v) => !v);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  return { fullscreen, pseudoFs, toggle };
}
