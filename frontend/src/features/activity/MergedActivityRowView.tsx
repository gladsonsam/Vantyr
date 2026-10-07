import { ExternalLink, ImageIcon, Layout } from "lucide-react";
import { apiUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { fmtDateTimePrecise } from "@/lib/utils";
import { alertChannelLabel } from "./alertChannels";
import type { ActivityUrlStateV1 } from "./activityUrl";
import { isHttpUrl, type MergedActivityRow } from "./sessionTimeline";

/** Renders a captured URL as a link only when its scheme is http(s); otherwise plain text. */
function UrlRow({ url, browser }: { url: string; browser?: string }) {
  const text = url.length > 120 ? url.slice(0, 120) + "…" : url;
  const inner = (
    <>
      <ExternalLink size={10} className="vtl-url-icon" />
      <span className="vtl-url-text">{text}</span>
      {browser ? <span className="vtl-url-browser">{browser}</span> : null}
    </>
  );
  return isHttpUrl(url) ? (
    <a href={url} target="_blank" rel="noreferrer" className="vtl-merged-url-row">
      {inner}
    </a>
  ) : (
    <span className="vtl-merged-url-row" title="Non-web URL (not linkable)">
      {inner}
    </span>
  );
}

export function MergedActivityRowView({
  row,
  onOpenScreenshot,
  agentId,
  onActivityDeepLink,
}: {
  row: MergedActivityRow;
  onOpenScreenshot: (eventId: number) => void;
  agentId?: string;
  onActivityDeepLink?: (state: ActivityUrlStateV1) => void;
}) {
  if (row.kind === "window") {
    const win = row.window;
    return (
      <div className="vtl-merged-row vtl-merged-row--kind-window">
        <div className="vtl-merged-head">
          <span className="vtl-merged-time">{fmtDateTimePrecise(win.timestamp)}</span>
          <span className="text-xs font-medium text-muted-foreground">Window</span>
          {agentId && onActivityDeepLink && (win.window_title ?? "").trim() ? (
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onActivityDeepLink({ v: 1, q: win.window_title });
              }}
            >
              Search
            </Button>
          ) : null}
        </div>
        <div className="vtl-merged-body">
          <span className="vtl-merged-window-line">
            <Layout size={12} className="vtl-merged-icon" />
            <span title={win.window_title} className="vtl-merged-window-title">{win.window_title}</span>
          </span>
        </div>
      </div>
    );
  }

  if (row.kind === "page") {
    const { window: win, url: u } = row;
    return (
      <div className="vtl-merged-row vtl-merged-row--kind-page">
        <div className="vtl-merged-head">
          <span className="vtl-merged-time">{fmtDateTimePrecise(win.timestamp)}</span>
          <span title="Window and URL captured together" className="text-xs font-medium text-info">
            Page
          </span>
          {agentId && onActivityDeepLink && u.url.trim() ? (
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onActivityDeepLink({ v: 1, q: u.url });
              }}
            >
              Search URL
            </Button>
          ) : null}
        </div>
        <div className="vtl-merged-body">
          <span className="vtl-merged-window-line">
            <Layout size={12} className="vtl-merged-icon" />
            <span title={win.window_title} className="vtl-merged-window-title">{win.window_title}</span>
          </span>
          <UrlRow url={u.url} browser={u.browser} />
        </div>
      </div>
    );
  }

  if (row.kind === "url") {
    const u = row.url;
    return (
      <div className="vtl-merged-row vtl-merged-row--kind-url">
        <div className="vtl-merged-head">
          <span className="vtl-merged-time">{fmtDateTimePrecise(u.timestamp)}</span>
          <span className="text-xs font-medium text-info">URL</span>
          {agentId && onActivityDeepLink && u.url.trim() ? (
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onActivityDeepLink({ v: 1, q: u.url });
              }}
            >
              Search URL
            </Button>
          ) : null}
        </div>
        <div className="vtl-merged-body">
          <UrlRow url={u.url} browser={u.browser} />
        </div>
      </div>
    );
  }

  const ev = row.alert;
  const ruleName = (ev.rule_name || "—").trim() || "—";
  const triggerText = (ev.snippet || "").trim();
  const triggerLooksLikeUrl = isHttpUrl(triggerText);
  return (
    <div className="vtl-merged-row vtl-merged-row--kind-alert">
      <div className="vtl-merged-head">
        <span className="vtl-merged-time">{fmtDateTimePrecise(ev.created_at)}</span>
        <span className="text-xs font-medium text-destructive">Alert</span>
        <span className="text-xs text-muted-foreground">
          {alertChannelLabel(ev.channel)}
        </span>
      </div>
      <div className="vtl-merged-body">
        <div className="vtl-alert-detail">
          <div className="vtl-alert-detail-row">
            <div className="vtl-alert-detail-label">Rule</div>
            <div className="vtl-alert-detail-value vtl-alert-detail-value--rule">{ruleName}</div>
          </div>
          <div className="vtl-alert-detail-row">
            <div className="vtl-alert-detail-label">Trigger</div>
            <div className="vtl-alert-detail-value">
              {triggerText ? (
                triggerLooksLikeUrl ? (
                  <a
                    className="vtl-alert-trigger-link font-mono"
                    href={triggerText}
                    target="_blank"
                    rel="noreferrer"
                    title={triggerText}
                  >
                    {triggerText}
                  </a>
                ) : (
                  <span className="vtl-alert-trigger-text font-mono" title={triggerText}>
                    {triggerText}
                  </span>
                )
              ) : (
                <span className="vtl-alert-trigger-missing">—</span>
              )}
            </div>
          </div>
        </div>
        {ev.has_screenshot ? (
          <button
            type="button"
            className="vtl-alert-shot-btn"
            onClick={() => onOpenScreenshot(ev.id)}
            title="View full size"
          >
            <img
              src={apiUrl(`/alert-rule-events/${ev.id}/screenshot`)}
              alt=""
              className="vtl-alert-shot-thumb"
              loading="lazy"
            />
            <span className="vtl-alert-shot-hint">
              <ImageIcon size={12} /> Full size
            </span>
          </button>
        ) : ev.screenshot_requested ? (
          <p className="vtl-alert-shot-miss">
            No screenshot yet.
          </p>
        ) : null}
      </div>
    </div>
  );
}
