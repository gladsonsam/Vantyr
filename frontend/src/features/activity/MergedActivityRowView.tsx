import type { ReactNode } from "react";
import { Bell, ExternalLink, Layout, Search, type LucideIcon } from "lucide-react";
import { apiUrl } from "@/api";
import { cn, fmtDateTimePrecise, parseTimestamp } from "@/lib/utils";
import { alertChannelLabel } from "./alertChannels";
import type { ActivityUrlState } from "./activityUrl";
import { isHttpUrl, type MergedActivityRow } from "./sessionTimeline";

/** Left rule hue per row kind: windows info-blue, pages/URLs brand, alerts destructive. */
const KIND_BORDER: Record<MergedActivityRow["kind"], string> = {
  window: "border-l-info",
  page: "border-l-primary",
  url: "border-l-primary",
  alert: "border-l-destructive",
};

const KIND_LABEL: Record<MergedActivityRow["kind"], string> = {
  window: "Window",
  page: "Page",
  url: "URL",
  alert: "Alert",
};

const KIND_ICON: Record<MergedActivityRow["kind"], LucideIcon> = {
  window: Layout,
  page: ExternalLink,
  url: ExternalLink,
  alert: Bell,
};

function clock(time: string | undefined): string {
  const date = parseTimestamp(time);
  return date
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
}

/** One evidence row: time, kind icon (named for screen readers), content, optional action. */
function RowShell({
  kind,
  time,
  action,
  children,
}: {
  kind: MergedActivityRow["kind"];
  time: string | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  const Icon = KIND_ICON[kind];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 border-l-2 py-2 pl-3 not-first:border-t",
        KIND_BORDER[kind],
      )}
    >
      <span
        title={fmtDateTimePrecise(time)}
        className="w-[4.5rem] shrink-0 pt-px tabular-nums text-[11.5px] text-muted-foreground"
      >
        {clock(time)}
      </span>
      <Icon
        size={13}
        aria-hidden="true"
        className={cn(
          "mt-0.5 shrink-0",
          kind === "alert" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <span className="sr-only">{KIND_LABEL[kind]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {action}
    </div>
  );
}

/** Jumps to a timeline search for this text; sized for touch, labelled for screen readers. */
function SearchAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="-my-1.5 -mr-1.5 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      <Search size={14} aria-hidden="true" />
    </button>
  );
}

function WindowLine({ title }: { title: string }) {
  return (
    <span title={title} className="min-w-0 truncate text-[12.5px] text-foreground">
      {title}
    </span>
  );
}

/** Renders a captured URL as a link only when its scheme is http(s); otherwise plain text. */
function UrlRow({ url, browser }: { url: string; browser?: string }) {
  const text = url.length > 120 ? url.slice(0, 120) + "…" : url;
  const className = "group/url flex min-w-0 items-baseline gap-2 text-info no-underline";
  const inner = (
    <>
      <span className="truncate tabular-nums text-[11.5px] group-hover/url:underline">{text}</span>
      {browser ? (
        <span className="shrink-0 text-[10.5px] text-muted-foreground">{browser}</span>
      ) : null}
    </>
  );
  return isHttpUrl(url) ? (
    <a href={url} target="_blank" rel="noreferrer" title={url} className={className}>
      {inner}
    </a>
  ) : (
    <span className={className} title="Non-web URL (not linkable)">
      {inner}
    </span>
  );
}

type RowProps = {
  row: MergedActivityRow;
  onOpenScreenshot: (eventId: number) => void;
  agentId?: string;
  onActivityDeepLink?: (state: ActivityUrlState) => void;
};
type DeepLink = ((state: ActivityUrlState) => void) | null;

/** One row of a session's merged window / URL / alert stream. */
export function MergedActivityRowView({
  row,
  onOpenScreenshot,
  agentId,
  onActivityDeepLink,
}: RowProps) {
  const deepLink = agentId && onActivityDeepLink ? onActivityDeepLink : null;
  switch (row.kind) {
    case "window":
      return <WindowActivityRow row={row} deepLink={deepLink} />;
    case "page":
    case "url":
      return <PageActivityRow row={row} deepLink={deepLink} />;
    case "alert":
      return <AlertActivityRow row={row} onOpenScreenshot={onOpenScreenshot} />;
  }
}

function WindowActivityRow({
  row,
  deepLink,
}: {
  row: Extract<MergedActivityRow, { kind: "window" }>;
  deepLink: DeepLink;
}) {
  const win = row.window;
  const title = (win.window_title ?? "").trim();
  return (
    <RowShell
      kind="window"
      time={win.timestamp}
      action={
        deepLink && title ? (
          <SearchAction
            label={`Search the timeline for “${title}”`}
            onClick={() => deepLink({ q: win.window_title })}
          />
        ) : null
      }
    >
      <WindowLine title={win.window_title} />
    </RowShell>
  );
}

function PageActivityRow({
  row,
  deepLink,
}: {
  row: Extract<MergedActivityRow, { kind: "page" | "url" }>;
  deepLink: DeepLink;
}) {
  const u = row.url;
  return (
    <RowShell
      kind={row.kind}
      time={row.kind === "page" ? row.window.timestamp : u.timestamp}
      action={
        deepLink && u.url.trim() ? (
          <SearchAction
            label="Search the timeline for this URL"
            onClick={() => deepLink({ q: u.url })}
          />
        ) : null
      }
    >
      {row.kind === "page" ? <WindowLine title={row.window.window_title} /> : null}
      <UrlRow url={u.url} browser={u.browser} />
    </RowShell>
  );
}

function AlertActivityRow({
  row,
  onOpenScreenshot,
}: {
  row: Extract<MergedActivityRow, { kind: "alert" }>;
  onOpenScreenshot: (eventId: number) => void;
}) {
  const ev = row.alert;
  const ruleName = (ev.rule_name || "").trim() || "Unnamed rule";
  const triggerText = (ev.snippet || "").trim();
  return (
    <RowShell kind="alert" time={ev.created_at}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-[12.5px] font-semibold text-warning">{ruleName}</span>
        <span className="text-xs text-muted-foreground">{alertChannelLabel(ev.channel)}</span>
      </div>
      {triggerText ? (
        isHttpUrl(triggerText) ? (
          <a
            className="tabular-nums text-[12px] text-info no-underline [word-break:break-word] hover:underline"
            href={triggerText}
            target="_blank"
            rel="noreferrer"
            title={triggerText}
          >
            {triggerText}
          </a>
        ) : (
          <span
            className="tabular-nums text-[12px] text-muted-foreground [word-break:break-word]"
            title={triggerText}
          >
            {triggerText}
          </span>
        )
      ) : null}
      {ev.has_screenshot ? (
        <button
          type="button"
          className="mt-1 cursor-pointer self-start overflow-hidden rounded-lg border border-foreground/10 hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onOpenScreenshot(ev.id)}
          aria-label="View alert screenshot full size"
          title="View full size"
        >
          <img
            src={apiUrl(`/alert-rule-events/${ev.id}/screenshot`)}
            alt=""
            className="block max-h-32 max-w-full"
            loading="lazy"
          />
        </button>
      ) : ev.screenshot_requested ? (
        <span className="text-[11px] text-muted-foreground">Screenshot pending</span>
      ) : null}
    </RowShell>
  );
}
