import type { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { ThemeContext } from "./useAppTheme";

/** Applies the stored theme to the document and shares it with the settings page. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
