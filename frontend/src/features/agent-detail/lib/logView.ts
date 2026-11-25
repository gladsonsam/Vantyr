export interface FilteredLog {
  text: string;
  shown: number;
  total: number;
}

/** Lines of a log tail; the newline that ends the last line doesn't start another one. */
export function logLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Keeps the lines that contain `query` (any letter case); a blank query keeps everything. */
export function filterLog(text: string, query: string): FilteredLog {
  const lines = logLines(text);
  const needle = query.trim().toLowerCase();
  if (!needle) return { text, shown: lines.length, total: lines.length };
  const kept = lines.filter((line) => line.toLowerCase().includes(needle));
  return { text: kept.join("\n"), shown: kept.length, total: lines.length };
}

/** "1,204 lines" or "12 of 1,204 lines". */
export function logCountLabel({ shown, total }: FilteredLog): string {
  const noun = total === 1 ? "line" : "lines";
  return shown === total ? `${total.toLocaleString()} ${noun}` : `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`;
}

/** What the empty log box says: loading, failed, nothing matched, or nothing logged. */
export function logPlaceholder({ failed, waiting, filtering, total }: { failed: boolean; waiting: boolean; filtering: boolean; total: number }): string {
  if (failed) return "The log couldn’t be loaded.";
  if (waiting) return "Loading…";
  if (filtering && total > 0) return "No lines match this filter.";
  return "Nothing has been logged yet.";
}
