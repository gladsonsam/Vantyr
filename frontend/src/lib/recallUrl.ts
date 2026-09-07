/**
 * Links *into* Recall.
 *
 * Recall used to be reachable only from its own page, with its own device picker —
 * so every other timestamped view in the dashboard (the activity timeline, window
 * focus events, URL visits, rule events) could tell you when something happened but
 * not show you the screen. These helpers make "see this moment" a one-click action
 * from anywhere that has an agent and a timestamp.
 *
 * `at` is the same param the activity timeline already uses for its highlight, so a
 * single URL shape serves both tabs.
 */

/** Agent-detail URL opening the Recall tab on `iso`. */
export function agentRecallHref(agentId: string, iso?: string | null): string {
  const qs = new URLSearchParams({ tab: "recall" });
  if (iso) qs.set("at", iso);
  return `/agents/${agentId}?${qs.toString()}`;
}

/** Standalone Recall page URL, pre-selecting an agent and optionally a moment. */
export function recallPageHref(
  agentId: string,
  opts: { at?: string | null; day?: string | null; monitor?: number | null } = {},
): string {
  const qs = new URLSearchParams({ agent: agentId });
  if (opts.at) qs.set("at", opts.at);
  if (opts.day) qs.set("day", opts.day);
  if (opts.monitor != null) qs.set("monitor", String(opts.monitor));
  return `/recall?${qs.toString()}`;
}
