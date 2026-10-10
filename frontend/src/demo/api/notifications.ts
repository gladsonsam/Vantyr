import type { ApiClient } from "@/api";

/** Fake notification settings and push endpoints. */
export function demoNotificationsApi(): Partial<ApiClient> {
  return {
    // Demo-only mock; keep the channel list in sync with PROVIDER_CATALOG in
    // server/src/notify/mod.rs (the real source of truth) when channels change.
    notificationsStatus: async () => ({
      any_enabled: true,
      providers: [
        { id: "email", label: "Email (SMTP)", description: "Send alert emails through any SMTP server.", env_keys: ["SMTP_HOST", "SMTP_FROM", "SMTP_TO", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_TLS", "SMTP_SUBJECT_PREFIX"], docs_url: "", enabled: true },
        { id: "slack", label: "Slack", description: "Post alerts to a Slack channel via an Incoming Webhook.", env_keys: ["SLACK_WEBHOOK_URL"], docs_url: "https://api.slack.com/messaging/webhooks", enabled: true },
        { id: "discord", label: "Discord", description: "Post alerts to a Discord channel via a channel Webhook.", env_keys: ["DISCORD_WEBHOOK_URL"], docs_url: "https://support.discord.com/hc/en-us/articles/228383668", enabled: false },
        { id: "teams", label: "Microsoft Teams", description: "Post alerts to a Teams channel via an Incoming Webhook.", env_keys: ["TEAMS_WEBHOOK_URL"], docs_url: "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using", enabled: false },
        { id: "telegram", label: "Telegram", description: "Send alerts to a Telegram chat through a bot.", env_keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], docs_url: "https://core.telegram.org/bots", enabled: false },
        { id: "ntfy", label: "ntfy", description: "Push alerts to an ntfy topic (ntfy.sh or self-hosted).", env_keys: ["NTFY_URL", "NTFY_TOKEN"], docs_url: "https://docs.ntfy.sh/", enabled: false },
        { id: "pushover", label: "Pushover", description: "Send push notifications to your devices via Pushover.", env_keys: ["PUSHOVER_TOKEN", "PUSHOVER_USER_KEY"], docs_url: "https://pushover.net/api", enabled: false },
        { id: "webhook", label: "Webhook", description: "POST the raw alert JSON to any HTTP endpoint.", env_keys: ["NOTIFY_WEBHOOK_URL", "NOTIFY_WEBHOOK_AUTH_HEADER"], docs_url: "", enabled: false },
        { id: "home_assistant", label: "Home Assistant", description: "Fire a custom event into Home Assistant for your automations.", env_keys: ["HOME_ASSISTANT_URL", "HOME_ASSISTANT_ACCESS_TOKEN", "HOME_ASSISTANT_EVENT_TYPE", "HOME_ASSISTANT_SKIP_TLS_VERIFY"], docs_url: "https://www.home-assistant.io/docs/automation/trigger/#event-trigger", enabled: false },
        { id: "web_push", label: "Browser push (Web Push)", description: "Send OS notifications to browsers/PWAs subscribed from the dashboard.", env_keys: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"], docs_url: "https://developer.mozilla.org/en-US/docs/Web/API/Push_API", enabled: false },
      ],
    }),
    // Demo has no server VAPID key, so browser push reports "not configured".
    pushVapidPublicKey: async () => ({ publicKey: null, enabled: false }),
    pushSubscribe: async () => ({ ok: true }),
    pushUnsubscribe: async () => ({ ok: true }),
    notificationsTest: async () => ({
      all_ok: true,
      results: [
        { id: "email", ok: true, error: null },
        { id: "slack", ok: true, error: null },
      ],
    }),
  };
}
