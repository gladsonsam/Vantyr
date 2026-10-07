import { useMemo, useState } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Globe,
  Keyboard,
  Lock,
  Moon,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { AppIcon } from "@/components/common/AppIcon";
import { Button } from "@vantyr/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vantyr/ui/components/tooltip";
import { cn } from "@/lib/utils";
import type { ActivityUrlStateV1 } from "./activityUrl";
import { MergedActivityRowView } from "./MergedActivityRowView";
import { type Session, formatDuration } from "./sessionAggregator";
import {
  buildMergedActivityTimeline,
  fmtTime,
  formatTimeRange,
  isLockScreenApp,
} from "./sessionTimeline";

/** Count in a session's meta line: muted icon + number, named by its tooltip. */
function MetaCount({
  icon: Icon,
  count,
  label,
  iconClassName,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
  iconClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums" />}
      >
        <Icon size={11} aria-hidden="true" className={iconClassName} />
        <span className="sr-only">{label}: </span>
        {count}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const KEYSTROKE_PREVIEW = 3;

/** One session on the timeline: time column, spine dot, and an expandable card. */
export function SessionItem({
  session,
  isLast,
  highlighted,
  forceExpanded,
  onOpenScreenshot,
  onFilterApp,
  agentId,
  onActivityDeepLink,
}: {
  session: Session;
  isLast: boolean;
  highlighted: boolean;
  forceExpanded: boolean;
  onOpenScreenshot: (eventId: number) => void;
  onFilterApp: (exeName: string) => void;
  agentId?: string;
  onActivityDeepLink?: (state: ActivityUrlStateV1) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const [showAllKeystrokes, setShowAllKeystrokes] = useState(false);
  const isOpen = userToggled ? expanded : forceExpanded || expanded;

  const mergedTimeline = useMemo(() => buildMergedActivityTimeline(session), [session]);
  const alertCount = session.alertEvents?.length ?? 0;
  const canExpand = mergedTimeline.length > 0 || session.hasKeystrokes;
  const isIdle = session.appName === "__idle__";
  const isLockScreen = !isIdle && isLockScreenApp(session.appName);

  const toggle = () => {
    setUserToggled(true);
    setExpanded((v) => !v);
  };

  const visibleKeystrokes = showAllKeystrokes ? session.keystrokes : session.keystrokes.slice(0, KEYSTROKE_PREVIEW);
  const hiddenKeystrokes = session.keystrokes.length - KEYSTROKE_PREVIEW;

  return (
    <div className="grid grid-cols-[60px_18px_minmax(0,1fr)] items-stretch gap-x-3">
      {/* Left: timestamp */}
      <div className="flex flex-col items-end gap-0.5 pt-[11px]">
        <span className="font-mono text-[12.5px] font-semibold text-muted-foreground tabular-nums">
          {fmtTime(session.startTime)}
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground/72">{formatDuration(session.duration)}</span>
        {highlighted && (
          <span className="mt-0.5 inline-flex text-warning" title="Notification fired near this time">
            <Bell size={10} />
          </span>
        )}
      </div>

      {/* Center: dot + line */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "z-1 mt-[13px] size-2.5 shrink-0 rounded-full border-2 bg-card",
            highlighted
              ? "scale-130 border-success shadow-[0_0_0_4px_var(--ui-border)]"
              : "border-foreground shadow-[0_0_0_3px_var(--ui-border)]",
            isIdle && "opacity-55",
          )}
        />
        {!isLast && <div className="my-[3px] w-[1.5px] flex-1 rounded-[1px] bg-foreground/10" />}
      </div>

      {/* Right: card */}
      <div
        className={cn(
          "mb-2.5 overflow-hidden rounded-[12px] border bg-card transition-[border-color] duration-120 hover:border-foreground/10",
          isIdle && "bg-card/60",
          isLockScreen && "border-dashed",
          highlighted &&
            "rounded-[8px] outline-2 outline-offset-2 outline-success shadow-[0_0_0_6px_var(--ui-border)] animate-[vtl-highlight-pulse_1.8s_ease_2]",
        )}
      >
        <div
          className={cn("flex items-start justify-between gap-2.5 px-[13px] py-[11px]", canExpand ? "cursor-pointer" : "cursor-default")}
          onClick={() => {
            if (canExpand) toggle();
          }}
          role={canExpand ? "button" : undefined}
          tabIndex={canExpand ? 0 : undefined}
          onKeyDown={(e) => {
            if (canExpand && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div
              className={cn(
                "flex flex-wrap items-center gap-2 text-[13.5px] font-semibold tracking-[-0.01em]",
                isIdle ? "text-muted-foreground/72" : "text-foreground",
              )}
            >
              {isIdle && <Moon size={14} />}
              {!isIdle ? (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (session.appName) onFilterApp(session.appName);
                    }}
                    title="Filter timeline by this app"
                    className="-ml-2 gap-1.5 font-semibold"
                  >
                    {isLockScreen ? <Lock size={12} /> : null}
                    {session.agentId ? <AppIcon agentId={session.agentId} exeName={session.appName} size={14} /> : null}
                    <span>{session.appDisplayName || session.appName}</span>
                  </Button>
                  {session.user ? (
                    <span
                      className="inline-flex items-center gap-1 font-mono text-[11px] font-medium text-muted-foreground"
                      title="Signed-in user"
                    >
                      <UserRound size={11} aria-hidden="true" />
                      {session.user}
                    </span>
                  ) : null}
                </>
              ) : (
                <span>Idle</span>
              )}
              {highlighted && (
                <span className="flex items-center gap-[3px] text-[11px]">
                  <Bell size={11} /> Alert fired
                </span>
              )}
            </div>
            {!isIdle && session.windowTitle && session.windowTitle !== session.appName ? (
              <div className="mt-0.5 truncate text-[13.5px] font-semibold text-foreground">{session.windowTitle}</div>
            ) : isIdle ? (
              <div className="mt-0.5 text-[13px] text-muted-foreground">No activity</div>
            ) : null}
            {!isIdle && (
              <div className="mt-px font-mono text-[11px] text-muted-foreground">
                {isLockScreen ? null : session.appName}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground/72">
                {formatTimeRange(session.startTime, session.endTime)}
              </span>
              {session.hasKeystrokes && (
                <MetaCount icon={Keyboard} count={session.keystrokeCount} label="Keystrokes" />
              )}
              {session.hasUrls && (
                <MetaCount icon={Globe} count={session.urls.length} label="URLs visited" />
              )}
              {alertCount > 0 && (
                <MetaCount icon={Bell} count={alertCount} label="Alerts fired" iconClassName="text-destructive" />
              )}
            </div>
          </div>
          {canExpand && (
            <span className="flex shrink-0 items-center pt-0.5 text-muted-foreground/72">
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          )}
        </div>

        {isOpen && (
          <div className="flex flex-col gap-[18px] border-t bg-muted/45 px-[13px] py-3.5">
            {mergedTimeline.length > 0 && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Timeline ({mergedTimeline.length})</SectionLabel>
                <div className="flex flex-col">
                  {mergedTimeline.map((row, i) => (
                    <MergedActivityRowView
                      key={`${row.kind}-${row.kind === "window"
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

            {session.hasKeystrokes && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Keystrokes ({session.keystrokes.length} sessions)</SectionLabel>
                <div className="flex flex-col gap-1.5">
                  {visibleKeystrokes.map((ks, i) => (
                    <code
                      key={i}
                      className="block rounded-[8px] border bg-background px-[11px] py-[9px] font-mono text-[12px] whitespace-pre-wrap text-foreground [word-break:break-word]"
                    >
                      {ks.keys.slice(0, 80)}
                      {ks.keys.length > 80 ? "…" : ""}
                    </code>
                  ))}
                  {hiddenKeystrokes > 0 && (
                    <button
                      type="button"
                      className="cursor-pointer text-left opacity-75"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAllKeystrokes((v) => !v);
                      }}
                    >
                      {showAllKeystrokes ? "Show less" : `…and ${hiddenKeystrokes} more (click to expand)`}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 text-[10px] font-bold tracking-[0.1em] text-muted-foreground/48 uppercase">{children}</p>
  );
}
