import { useEffect } from "react";
import { invoke } from "../lib/tauri";

type AppTheme = "dark" | "light";

/**
 * The theme the UI actually renders in, read from the CSS `color-scheme` on
 * <html> rather than from the OS. The stylesheet is the single source of truth,
 * so if it ever gains a light palette the native chrome follows along with it.
 */
function appTheme(): AppTheme {
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  const dark = scheme.includes("dark");
  const light = scheme.includes("light");
  if (dark && !light) return "dark";
  if (light && !dark) return "light";
  // "normal" or "light dark": the stylesheet defers to the OS, so do the same.
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Keeps the native window chrome — on Windows the title bar with the
 * minimize/maximize/close buttons — matching the UI's theme. Without this the
 * OS draws its light title bar above the dark UI whenever Windows is set to
 * light mode.
 */
export function useNativeChromeTheme() {
  useEffect(() => {
    const sync = () => {
      const theme = appTheme();
      document.documentElement.classList.toggle("dark", theme === "dark");
      // Ignored outside the Tauri runtime (e.g. `vite dev` in a browser).
      invoke("set_window_theme", { dark: theme === "dark" }).catch(() => {});
    };

    sync();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
}
