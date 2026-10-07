// Windows-style path helpers for the remote file browser.

/** Pseudo-path the agent answers with its drive list ("This PC"). */
export const DRIVES_PATH = "__this_pc__";

export function joinPath(base: string, name: string): string {
  if (!base) return name;
  if (base.endsWith("\\")) return base + name;
  return base + "\\" + name;
}

/** Last segment of an agent path (`C:\Users\a\notes.txt` → `notes.txt`). */
export function baseName(path: string): string {
  return path.split("\\").filter(Boolean).pop() ?? "";
}

export type Breadcrumb = { text: string; path: string };

/** Crumbs from "Root" (the drive list) down to `currentPath`; each path ends with a backslash. */
export function breadcrumbs(currentPath: string): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [{ text: "Root", path: DRIVES_PATH }];
  if (!currentPath || currentPath === DRIVES_PATH) return crumbs;
  let accumulated = "";
  for (const part of currentPath.split("\\").filter((p) => p)) {
    accumulated += part + "\\";
    crumbs.push({ text: part, path: accumulated });
  }
  return crumbs;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
