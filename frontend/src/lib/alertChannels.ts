/**
 * Display helpers for alert-rule channels.
 *
 * The five channels mirror the server's `alert_rules.channel` CHECK constraint
 * (see migration 0057). Several call sites used to inline
 * `channel === "url" ? "URL" : channel === "keys" ? "Keys" : channel`, which
 * rendered the raw `url_category` / `resource` / `agent_offline` in the UI.
 */

/** The five channels an alert rule can fire on. */
export type AlertChannelKey =
  | "url"
  | "keys"
  | "url_category"
  | "resource"
  | "agent_offline";

const CHANNEL_LABELS: Record<AlertChannelKey, string> = {
  url: "URL",
  keys: "Keystrokes",
  url_category: "URL category",
  resource: "Resource",
  agent_offline: "Agent offline",
};

const CHANNEL_BADGE_COLORS: Record<AlertChannelKey, string> = {
  url: "blue",
  keys: "grey",
  url_category: "purple",
  resource: "severity-medium",
  agent_offline: "red",
};

/** Human label for a channel, falling back to the raw value for anything unknown. */
export function alertChannelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as AlertChannelKey] ?? channel;
}

/** Badge colour for a channel, so the four non-URL channels stay distinguishable. */
export function alertChannelBadgeColor(channel: string): string {
  return CHANNEL_BADGE_COLORS[channel as AlertChannelKey] ?? "grey";
}