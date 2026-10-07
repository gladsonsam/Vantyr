import { useEffect, useState, useSyncExternalStore } from "react";

enum Mode {
  Light = "light",
  Dark = "dark",
}

export type ThemeMode = "light" | "dark" | "system";

// Single source of truth for theme across the app (matches `index.html` bootstrap).
const THEME_STORAGE_KEY = "theme";

function getSystemTheme(): Mode {
  if (typeof window === "undefined") return Mode.Light;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? Mode.Dark
    : Mode.Light;
}

function getStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function subscribeSystemTheme(change: () => void) {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", change);
  return () => mediaQuery.removeEventListener("change", change);
}

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);
  // The OS preference is external state: subscribe to it and derive the
  // effective mode during render instead of syncing it in an effect.
  const systemDark = useSyncExternalStore(
    subscribeSystemTheme,
    () => getSystemTheme() === Mode.Dark,
    () => false,
  );
  const effectiveMode =
    themeMode === "system" ? (systemDark ? Mode.Dark : Mode.Light) : themeMode === "dark" ? Mode.Dark : Mode.Light;

  useEffect(() => {
    // Drives the `.dark` token block in index.css.
    document.documentElement.classList.toggle("dark", effectiveMode === Mode.Dark);
  }, [effectiveMode]);

  const changeTheme = (newMode: ThemeMode) => {
    setThemeMode(newMode);
    localStorage.setItem(THEME_STORAGE_KEY, newMode);
  };

  return {
    themeMode,
    effectiveMode,
    changeTheme,
    isDark: effectiveMode === Mode.Dark,
  };
}
