import { createContext, useContext } from "react";
import type { useTheme } from "@/hooks/useTheme";

export type AppThemeValue = ReturnType<typeof useTheme>;

export const ThemeContext = createContext<AppThemeValue | null>(null);

/** The app-wide theme preference (applied to the document by ThemeProvider). */
export function useAppTheme(): AppThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useAppTheme must be used inside ThemeProvider");
  return value;
}
