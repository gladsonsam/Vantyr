/**
 * Friendly Windows app-name resolution for the dashboard.
 *
 * The authoritative friendly name is computed server-/agent-side and arrives as
 * `app_display`. This module is the presentation-layer fallback: it maps common
 * exes to canonical product names and, for anything unknown, derives a readable
 * title-cased label from the exe (so "WindowsTerminal.exe" reads "Windows
 * Terminal", not a raw filename).
 *
 * Add more mappings here to expand the canonical "friendly app name" list.
 * Keys are lowercase exe names (with `.exe`).
 */
export const EXE_FRIENDLY_NAMES: Record<string, string> = {
  // Microsoft Office
  "winword.exe": "Microsoft Word",
  "excel.exe": "Microsoft Excel",
  "powerpnt.exe": "Microsoft PowerPoint",
  "outlook.exe": "Microsoft Outlook",
  "onenote.exe": "Microsoft OneNote",
  "msaccess.exe": "Microsoft Access",
  "mspub.exe": "Microsoft Publisher",
  // Browsers
  "chrome.exe": "Google Chrome",
  "msedge.exe": "Microsoft Edge",
  "firefox.exe": "Mozilla Firefox",
  "iexplore.exe": "Internet Explorer",
  "brave.exe": "Brave",
  "opera.exe": "Opera",
  "tor-browser.exe": "Tor Browser",
  // Dev tools
  "code.exe": "Visual Studio Code",
  "devenv.exe": "Visual Studio",
  "windowsterminal.exe": "Windows Terminal",
  "powershell.exe": "PowerShell",
  "pwsh.exe": "PowerShell",
  "cmd.exe": "Command Prompt",
  // Windows shell / system
  "explorer.exe": "File Explorer",
  "notepad.exe": "Notepad",
  "taskmgr.exe": "Task Manager",
  "mmc.exe": "Microsoft Management Console",
  "lockapp.exe": "Lock screen",
  // Communication & media
  "teams.exe": "Microsoft Teams",
  "ms-teams.exe": "Microsoft Teams",
  "slack.exe": "Slack",
  "discord.exe": "Discord",
  "zoom.exe": "Zoom",
  "spotify.exe": "Spotify",
  "steam.exe": "Steam",
  // Design / docs
  "figma.exe": "Figma",
  "acrobat.exe": "Adobe Acrobat",
  "acrord32.exe": "Adobe Acrobat Reader",
};

function friendlyNameFromExe(exeName: string | undefined | null): string | null {
  const exe = (exeName ?? "").trim().toLowerCase();
  if (exe in EXE_FRIENDLY_NAMES) return EXE_FRIENDLY_NAMES[exe]!;
  return null;
}

/** True when a string looks like a raw exe filename rather than a friendly name. */
function looksLikeExe(s: string): boolean {
  return /\.exe$/i.test(s);
}

/**
 * Derive a readable, title-cased label from an exe name.
 * Strips a trailing `.exe`, splits on separators and camelCase/PascalCase
 * boundaries, then capitalizes each token. e.g.
 *   "windowsterminal.exe" → "Windowsterminal"  (no boundary to split on)
 *   "WindowsTerminal.exe" → "Windows Terminal"
 *   "my-cool_app.exe"     → "My Cool App"
 *   "app.exe"             → "App"
 */
export function titleCaseExe(raw: string): string {
  const original = raw.trim();
  // Strip a single trailing ".exe" (case-insensitive). Do NOT split on "." so
  // version-bearing names like "tool-v1.2.exe" aren't mangled.
  const stem = original.replace(/\.exe$/i, "");
  if (!stem) return original;
  const spaced = stem
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const tokens = spaced.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return original;
  return tokens
    .map((t) => (t.length <= 1 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(" ");
}

/**
 * Normalize Windows app labels across the dashboard.
 *
 * Resolution order:
 *  1. Canonical friendly name for known exes (Word/Chrome/Edge/…).
 *  2. A real server-provided `appDisplay` (anything that isn't just the exe).
 *  3. A title-cased label derived from the exe (or an exe-like display value).
 *  4. "—" when nothing is available.
 */
export function prettyAppLabel(opts: {
  exeName?: string | null;
  appDisplay?: string | null;
}): string {
  const fromExe = friendlyNameFromExe(opts.exeName);
  if (fromExe) return fromExe;

  const display = (opts.appDisplay ?? "").trim();
  const exe = (opts.exeName ?? "").trim();

  // A server-provided friendly name: non-empty, not a raw exe, not equal to the exe.
  if (display && !looksLikeExe(display) && display.toLowerCase() !== exe.toLowerCase()) {
    return display;
  }

  const base = exe || display;
  if (base) return titleCaseExe(base);

  return "—";
}
