import { useState, useEffect } from "react";

export enum Mode {
  Light = "light",
  Dark = "dark",
}

export function applyMode(mode: Mode) {
  if (typeof document !== "undefined") {
    document.body.classList.toggle("awsui-dark-mode", mode === Mode.Dark);
    document.documentElement.classList.toggle("awsui-dark-mode", mode === Mode.Dark);
  }
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

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);
  const [effectiveMode, setEffectiveMode] = useState<Mode>(() => {
    const stored = getStoredTheme();
    return stored === "system" ? getSystemTheme() : stored === "dark" ? Mode.Dark : Mode.Light;
  });

  useEffect(() => {
    const setDomDarkClass = (mode: Mode) => {
      // Used by some Tailwind-authored bits; keep in sync with Cloudscape mode.
      document.documentElement.classList.toggle("dark", mode === Mode.Dark);
    };

    if (themeMode === "system") {
      const updateSystemTheme = () => {
        const systemMode = getSystemTheme();
        setEffectiveMode(systemMode);
        applyMode(systemMode);
        setDomDarkClass(systemMode);
      };

      updateSystemTheme();

      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", updateSystemTheme);
      return () => mediaQuery.removeEventListener("change", updateSystemTheme);
    } else {
      const mode = themeMode === "dark" ? Mode.Dark : Mode.Light;
      setEffectiveMode(mode);
      applyMode(mode);
      setDomDarkClass(mode);
    }
  }, [themeMode]);

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
