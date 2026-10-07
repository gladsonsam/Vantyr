import type { ReactNode } from "react";
import { ExternalLink, ImageIcon, Layout } from "lucide-react";
import { apiUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { cn, fmtDateTimePrecise } from "@/lib/utils";
import { alertChannelLabel } from "./alertChannels";
import type { ActivityUrlStateV1 } from "./activityUrl";
import { isHttpUrl, type MergedActivityRow } from "./sessionTimeline";

/** Left rule hue per row kind: windows info-blue, pages/URLs brand, alerts destructive. */
const KIND_BORDER: Record<MergedActivityRow["kind"], string> = {
  window: "border-l-info",
  page: "border-l-primary",
  url: "border-l-primary",
  alert: "border-l-destructive",
};

function RowShell({
  kind,
  time,
  head,
  children,
}: {
  kind: MergedActivityRow["kind"];
  time: string | undefined;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-[3px] border-l-2 py-[9px] pl-3 not-first:border-t", KIND_BORDER[kind])}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[11px] text-muted-foreground/72">{fmtDateTimePrecise(time)}</span>
        {head}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function SearchLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="link"
      className="h-auto p-0 text-xs"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      {label}
    </Button>
  );
}

function WindowLine({ title }: { title: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-foreground">
      <Layout size={12} className="shrink-0 text-muted-foreground/72" />
      <span title={title} className="min-w-0 truncate">{title}</span>
    </span>
  );
}

/** Renders a captured URL as a link only when its scheme is http(s); otherwise plain text. */
function UrlRow({ url, browser }: { url: string; browser?: string }) {
  const text = url.length > 120 ? url.slice(0, 120) + "…" : url;
  const className = "group/url flex min-w-0 items-center gap-1.5 text-info no-underline";
  const inner = (
    <>
      <ExternalLink size={10} className="shrink-0 text-muted-foreground/72" />
      <span className="truncate font-mono text-[11.5px] text-info group-hover/url:underline">{text}</span>
      {browser ? <span className="shrink-0 text-[10.5px] text-muted-foreground/72">{browser}</span> : null}
    </>
  );
  return isHttpUrl(url) ? (
    <a href={url} target="_blank" rel="noreferrer" className={className}>
      {inner}
    </a>
  ) : (
    <span className={className} title="Non-web URL (not linkable)">
      {inner}
    </span>
  );
}

function AlertDetail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2.5">
      <div className="text-[10.5px] font-bold tracking-[0.06em] text-muted-foreground/48 uppercase">{label}</div>
      {children}
    </div>
  );
}

/** One row of a session's merged window / URL / alert stream. */
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
  const deepLink = agentId && onActivityDeepLink ? onActivityDeepLink : null;

  if (row.kind === "window") {
    const win = row.window;
    return (
      <RowShell
        kind="window"
        time={win.timestamp}
        head={
          <>
            <span className="text-xs font-medium text-muted-foreground">Window</span>
            {deepLink && (win.window_title ?? "").trim() ? (
              <SearchLink label="Search" onClick={() => deepLink({ v: 1, q: win.window_title })} />
            ) : null}
          </>
        }
      >
        <WindowLine title={win.window_title} />
      </RowShell>
    );
  }

  if (row.kind === "page" || row.kind === "url") {
    const u = row.url;
    return (
      <RowShell
        kind={row.kind}
        time={row.kind === "page" ? row.window.timestamp : u.timestamp}
        head={
          <>
            {row.kind === "page" ? (
              <span title="Window and URL captured together" className="text-xs font-medium text-info">
                Page
              </span>
            ) : (
              <span className="text-xs font-medium text-info">URL</span>
            )}
            {deepLink && u.url.trim() ? (
              <SearchLink label="Search URL" onClick={() => deepLink({ v: 1, q: u.url })} />
            ) : null}
          </>
        }
      >
        {row.kind === "page" ? <WindowLine title={row.window.window_title} /> : null}
        <UrlRow url={u.url} browser={u.browser} />
      </RowShell>
    );
  }

  const ev = row.alert;
  const ruleName = (ev.rule_name || "—").trim() || "—";
  const triggerText = (ev.snippet || "").trim();
  const triggerLooksLikeUrl = isHttpUrl(triggerText);
  return (
    <RowShell
      kind="alert"
      time={ev.created_at}
      head={
        <>
          <span className="text-xs font-medium text-destructive">Alert</span>
          <span className="text-xs text-muted-foreground">{alertChannelLabel(ev.channel)}</span>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <AlertDetail label="Rule">
          <div className="min-w-0 text-[12.5px] font-semibold text-warning">{ruleName}</div>
        </AlertDetail>
        <AlertDetail label="Trigger">
          <div className="min-w-0 text-[12.5px] text-foreground">
            {triggerText ? (
              triggerLooksLikeUrl ? (
                <a
                  className="font-mono text-[12px] text-info no-underline [word-break:break-word] hover:underline"
                  href={triggerText}
                  target="_blank"
                  rel="noreferrer"
                  title={triggerText}
                >
                  {triggerText}
                </a>
              ) : (
                <span className="font-mono text-[12px] text-muted-foreground [word-break:break-word]" title={triggerText}>
                  {triggerText}
                </span>
              )
            ) : (
              <span className="text-muted-foreground/72 italic">—</span>
            )}
          </div>
        </AlertDetail>
      </div>
      {ev.has_screenshot ? (
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-foreground/10 bg-muted px-2.5 py-[5px] text-[11.5px] font-semibold text-muted-foreground hover:border-foreground/16 hover:text-foreground"
          onClick={() => onOpenScreenshot(ev.id)}
          title="View full size"
        >
          <img
            src={apiUrl(`/alert-rule-events/${ev.id}/screenshot`)}
            alt=""
            className="max-w-[220px] cursor-pointer rounded-[8px] border border-foreground/10"
            loading="lazy"
          />
          <span className="text-[11px] text-muted-foreground/72">
            <ImageIcon size={12} /> Full size
          </span>
        </button>
      ) : ev.screenshot_requested ? (
        <p className="text-[11px] text-muted-foreground/72">No screenshot yet.</p>
      ) : null}
    </RowShell>
  );
}
