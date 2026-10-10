import { useMemo, useState } from "react";
import { Bell, ChevronRight, Globe, Keyboard, Lock, Moon, UserRound, type LucideIcon } from "lucide-react";
import { AppIcon } from "@/components/common/AppIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vantyr/ui/components/tooltip";
import { cn } from "@/lib/utils";
import type { ActivityUrlStateV1 } from "./activityUrl";
import { appColor, IDLE_APP } from "./appColor";
import { MergedActivityRowView } from "./MergedActivityRowView";
import { type Session, formatDuration } from "./sessionAggregator";
import { buildMergedActivityTimeline, fmtTime, formatTimeRange, isLockScreenApp } from "./sessionTimeline";

const KEYSTROKE_PREVIEW = 3;

function MetaCount({ icon: Icon, count, label, className }: { icon: LucideIcon; count: number; label: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("inline-flex items-center gap-1 text-[11.5px] text-muted-foreground tabular-nums", className)} />}
      >
        <Icon size={12} aria-hidden="true" />
        <span className="sr-only">{label}: </span>
        {count}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** What was typed in this session, flattened to one line for the collapsed row. */
function typedPreview(session: Session): string {
  return session.keystrokes
    .map((k) => k.keys)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One session as a compact row: time, app, window title, a one-line preview of what was typed,
 * and counts. Opening it shows the full window / URL / alert stream and every keystroke batch.
 */
export function SessionRow({
  session,
  highlighted,
  focused,
  onOpenScreenshot,
  onFilterApp,
  agentId,
  onActivityDeepLink,
}: {
  session: Session;
  highlighted: boolean;
  /** Picked from the day strip: open and keep marked. */
  focused: boolean;
  onOpenScreenshot: (eventId: number) => void;
  onFilterApp: (exeName: string) => void;
  agentId?: string;
  onActivityDeepLink?: (state: ActivityUrlStateV1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAllKeystrokes, setShowAllKeystrokes] = useState(false);

  // Open when picked from the day strip or deep-linked (adjusted during render, not in an effect).
  const forceOpen = focused || highlighted;
  const [prevForceOpen, setPrevForceOpen] = useState(false);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOpen(true);
  }

  const mergedTimeline = useMemo(() => buildMergedActivityTimeline(session), [session]);
  const typed = useMemo(() => typedPreview(session), [session]);
  const alertCount = session.alertEvents?.length ?? 0;
  const isIdle = session.appName === IDLE_APP;
  const isLockScreen = !isIdle && isLockScreenApp(session.appName);
  const canExpand = mergedTimeline.length > 0 || session.hasKeystrokes;
  const title = session.windowTitle && session.windowTitle !== session.appName ? session.windowTitle : "";
  const visibleKeystrokes = showAllKeystrokes ? session.keystrokes : session.keystrokes.slice(0, KEYSTROKE_PREVIEW);
  const hiddenKeystrokes = session.keystrokes.length - KEYSTROKE_PREVIEW;

  if (isIdle) {
    return (
      <div
        id={`vtl-s-${session.id}`}
        className={cn("flex items-center gap-3 px-3 py-1.5 text-xs text-muted-foreground/70", focused && "bg-muted/40")}
      >
        <span className="w-14 shrink-0 text-right tabular-nums">{fmtTime(session.startTime)}</span>
        <Moon size={12} aria-hidden />
        <span>Idle</span>
        <span>{formatDuration(session.duration)}</span>
      </div>
    );
  }

  return (
    <div
      id={`vtl-s-${session.id}`}
      className={cn(
        "border-l-2 transition-colors",
        open ? "bg-muted/30" : "hover:bg-muted/20",
        (focused || highlighted) && "bg-muted/50",
        highlighted && "animate-[vtl-highlight-pulse_1.8s_ease_2]",
      )}
      style={{ borderLeftColor: appColor(session.appName) }}
    >
      <div
        className={cn("flex items-start gap-3 px-3 py-2.5", canExpand && "cursor-pointer")}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? open : undefined}
        onClick={() => canExpand && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (canExpand && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="mt-0.5 w-14 shrink-0 text-right tabular-nums text-[12.5px] font-semibold text-muted-foreground tabular-nums">
          {fmtTime(session.startTime)}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            {isLockScreen ? (
              <Lock size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            ) : session.agentId ? (
              <AppIcon agentId={session.agentId} exeName={session.appName} size={16} />
            ) : null}
            <button
              type="button"
              title="Filter timeline by this app"
              onClick={(e) => {
                e.stopPropagation();
                if (session.appName) onFilterApp(session.appName);
              }}
              className="shrink-0 cursor-pointer text-[13.5px] font-semibold hover:underline"
            >
              {session.appDisplayName || session.appName}
            </button>
            {title && (
              <span title={title} className="min-w-0 truncate text-[13px] text-muted-foreground">
                {title}
              </span>
            )}
          </div>
          {typed && (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <Keyboard size={12} className="shrink-0" aria-hidden />
              <code className="font-sans min-w-0 truncate tabular-nums text-[12px] text-foreground/80">{typed}</code>
            </div>
          )}
        </div>

        <div className="mt-0.5 flex shrink-0 items-center gap-3">
          {highlighted && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-warning" title="Notification fired near this time">
              <Bell size={12} /> Alert fired
            </span>
          )}
          {session.user && (
            <span className="hidden items-center gap-1 tabular-nums text-[11px] text-muted-foreground xl:inline-flex" title="Signed-in user">
              <UserRound size={11} aria-hidden="true" />
              {session.user}
            </span>
          )}
          {session.hasKeystrokes && <MetaCount icon={Keyboard} count={session.keystrokeCount} label="Keystrokes" />}
          {session.hasUrls && <MetaCount icon={Globe} count={session.urls.length} label="URLs visited" />}
          {alertCount > 0 && <MetaCount icon={Bell} count={alertCount} label="Alerts fired" className="text-destructive" />}
          <span className="w-12 text-right tabular-nums text-[11.5px] text-muted-foreground tabular-nums">
            {session.duration > 0 ? formatDuration(session.duration) : ""}
          </span>
          <ChevronRight
            size={14}
            aria-hidden
            className={cn("text-muted-foreground/60 transition-transform", open && "rotate-90", !canExpand && "invisible")}
          />
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-5 border-t border-border/60 py-4 pr-4 pl-[84px]">
          <p className="tabular-nums text-[11.5px] text-muted-foreground">
            {formatTimeRange(session.startTime, session.endTime)} · {session.appName}
          </p>

          {session.hasKeystrokes && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Typed ({session.keystrokes.length} batches)</SectionLabel>
              <div className="flex flex-col gap-1.5">
                {visibleKeystrokes.map((ks, i) => (
                  <code
                    key={i}
                    className="block rounded-md font-sans bg-background/70 px-3 py-2 tabular-nums text-[12.5px] whitespace-pre-wrap text-foreground [word-break:break-word]"
                  >
                    {ks.keys.slice(0, 400)}
                    {ks.keys.length > 400 ? "…" : ""}
                  </code>
                ))}
                {hiddenKeystrokes > 0 && (
                  <button
                    type="button"
                    className="cursor-pointer self-start text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowAllKeystrokes((v) => !v)}
                  >
                    {showAllKeystrokes ? "Show less" : `…and ${hiddenKeystrokes} more`}
                  </button>
                )}
              </div>
            </div>
          )}

          {mergedTimeline.length > 0 && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Window &amp; page activity ({mergedTimeline.length})</SectionLabel>
              <div className="flex flex-col">
                {mergedTimeline.map((row, i) => (
                  <MergedActivityRowView
                    key={`${row.kind}-${
                      row.kind === "window"
                        ? row.window.id
                        : row.kind === "url"
                          ? row.url.id
                          : row.kind === "page"
                            ? `${row.window.id}-${row.url.id}`
                            : row.alert.id
                    }-${i}`}
                    row={row}
                    onOpenScreenshot={onOpenScreenshot}
                    agentId={agentId}
                    onActivityDeepLink={onActivityDeepLink}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground/60 uppercase">{children}</p>;
}
