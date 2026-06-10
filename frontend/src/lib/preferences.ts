/** Client-side UI preferences (localStorage). */

export type ThemePreference = "light" | "dark" | "system";

const THEME_KEY = "theme";
const NETWORK_IPV6_KEY = "vantyr.networkIncludeIpv6";
const ACTIVITY_CORRECTED_KEY = "vantyr.activityCorrectedKeys";

export function loadThemePreference(): ThemePreference {
  const v = localStorage.getItem(THEME_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function loadNetworkIncludeIpv6(): boolean {
  return localStorage.getItem(NETWORK_IPV6_KEY) === "1";
}

export function saveNetworkIncludeIpv6(value: boolean): void {
  localStorage.setItem(NETWORK_IPV6_KEY, value ? "1" : "0");
}

/** Default true — apply backspace-style corrections in Activity keystrokes. */
export function loadActivityCorrectedKeysDefault(): boolean {
  return localStorage.getItem(ACTIVITY_CORRECTED_KEY) !== "0";
}

export function saveActivityCorrectedKeysDefault(value: boolean): void {
  localStorage.setItem(ACTIVITY_CORRECTED_KEY, value ? "1" : "0");
}
