import { useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronRight,
  Globe,
  Keyboard,
  Lock,
  Moon,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { AppIcon } from "@/components/common/AppIcon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@vantyr/ui/components/tooltip";
import { cn } from "@/lib/utils";
import type { ActivityUrlStateV1 } from "./activityUrl";
import { appColor, IDLE_APP } from "./appColor";
import { MergedActivityRowView } from "./MergedActivityRowView";
import { type Session, formatDuration } from "./sessionAggregator";
import {
  buildMergedActivityTimeline,
  fmtTime,
  formatTimeRange,
  isLockScreenApp,
  type MergedActivityRow,
} from "./sessionTimeline";

const KEYSTROKE_PREVIEW = 3;
interface SessionRowProps {
  session: Session;
  highlighted: boolean;
  focused: boolean;
  onOpenScreenshot: (eventId: number) => void;
  onFilterApp: (exeName: string) => void;
  agentId?: string;
  onActivityDeepLink?: (state: ActivityUrlStateV1) => void;
  showUser?: boolean;
}
function MetaCount({
  icon: Icon,
  count,
  label,
  className,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11.5px] text-muted-foreground tabular-nums",
              className,
            )}
          />
        }
      >
        <Icon size={12} aria-hidden="true" />
        <span className="sr-only">{label}: </span>
        {count}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
function SessionCounts({ session }: { session: Session }) {
  const alertCount = session.alertEvents?.length ?? 0;
  return (
    <>
      {session.hasKeystrokes && (
        <MetaCount
          icon={Keyboard}
          count={session.keystrokeCount}
          label="Keystrokes"
        />
      )}
      {session.hasUrls && (
        <MetaCount
          icon={Globe}
          count={session.urls.length}
          label="URLs visited"
        />
      )}
      {alertCount > 0 && (
        <MetaCount
          icon={Bell}
          count={alertCount}
          label="Alerts fired"
          className="text-destructive"
        />
      )}
    </>
  );
}
function typedPreview(session: Session): string {
  return session.keystrokes
    .map((k) => k.keys)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
function SessionIdentity({
  session,
  typed,
  onFilterApp,
}: {
  session: Session;
  typed: string;
  onFilterApp: SessionRowProps["onFilterApp"];
}) {
  const title =
    session.windowTitle && session.windowTitle !== session.appName
      ? session.windowTitle
      : "";
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        {isLockScreenApp(session.appName) ? (
          <Lock
            size={14}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
        ) : session.agentId ? (
          <AppIcon
            agentId={session.agentId}
            exeName={session.appName}
            size={16}
          />
        ) : null}
        <button
          type="button"
          title="Filter timeline by this app"
          onClick={(event) => {
            event.stopPropagation();
            if (session.appName) onFilterApp(session.appName);
          }}
          className="shrink-0 cursor-pointer text-[13.5px] font-semibold hover:underline"
        >
          {session.appDisplayName || session.appName}
        </button>
        {title && (
          <span
            title={title}
            className="min-w-0 truncate text-[13px] text-muted-foreground"
          >
            {title}
          </span>
        )}
      </div>
      {typed && (
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Keyboard size={12} className="shrink-0" aria-hidden />
          <code className="font-sans min-w-0 truncate tabular-nums text-[12px] text-foreground/80">
            {typed}
          </code>
        </div>
      )}
      <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground empty:hidden sm:hidden">
        {session.duration > 0 && (
          <span className="tabular-nums">
            {formatDuration(session.duration)}
          </span>
        )}
        <SessionCounts session={session} />
      </div>
    </div>
  );
}
function DesktopSessionMeta({
  session,
  highlighted,
  showUser,
  open,
  canExpand,
}: Pick<SessionRowProps, "session" | "highlighted" | "showUser"> & {
  open: boolean;
  canExpand: boolean;
}) {
  return (
    <div className="mt-0.5 hidden shrink-0 items-center gap-3 sm:flex">
      {highlighted && (
        <span
          className="inline-flex items-center gap-1 text-[11.5px] text-warning"
          title="Notification fired near this time"
        >
          <Bell size={12} /> Alert fired
        </span>
      )}
      {showUser && session.user && (
        <span
          className="hidden items-center gap-1 tabular-nums text-[11px] text-muted-foreground xl:inline-flex"
          title="Signed-in user"
        >
          <UserRound size={11} aria-hidden="true" />
          {session.user}
        </span>
      )}
      <SessionCounts session={session} />
      <span className="w-12 text-right tabular-nums text-[11.5px] text-muted-foreground tabular-nums">
        {session.duration > 0 ? formatDuration(session.duration) : ""}
      </span>
      <ChevronRight
        size={14}
        aria-hidden
        className={cn(
          "text-muted-foreground/60 transition-transform",
          open && "rotate-90",
          !canExpand && "invisible",
        )}
      />
    </div>
  );
}
function SessionHeading({
  session,
  highlighted,
  showUser,
  open,
  canExpand,
  onToggle,
  onFilterApp,
  typed,
}: Pick<
  SessionRowProps,
  "session" | "highlighted" | "showUser" | "onFilterApp"
> & {
  open: boolean;
  canExpand: boolean;
  onToggle: () => void;
  typed: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        canExpand && "cursor-pointer",
      )}
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-expanded={canExpand ? open : undefined}
      onClick={() => {
        if (canExpand) onToggle();
      }}
      onKeyDown={(event) => {
        if (canExpand && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="mt-0.5 w-11 shrink-0 text-right text-[12.5px] font-semibold text-muted-foreground tabular-nums sm:w-14">
        {fmtTime(session.startTime)}
      </span>
      <SessionIdentity
        session={session}
        typed={typed}
        onFilterApp={onFilterApp}
      />
      <DesktopSessionMeta
        session={session}
        highlighted={highlighted}
        showUser={showUser}
        open={open}
        canExpand={canExpand}
      />
      {canExpand && (
        <ChevronRight
          size={14}
          aria-hidden
          className={cn(
            "mt-1 shrink-0 text-muted-foreground/60 transition-transform sm:hidden",
            open && "rotate-90",
          )}
        />
      )}
    </div>
  );
}
function mergedRowKey(row: MergedActivityRow): string {
  switch (row.kind) {
    case "window":
      return `window-${row.window.id}`;
    case "url":
      return `url-${row.url.id}`;
    case "page":
      return `page-${row.window.id}-${row.url.id}`;
    case "alert":
      return `alert-${row.alert.id}`;
  }
}
function TypedBatches({
  session,
  showAll,
  onToggle,
}: {
  session: Session;
  showAll: boolean;
  onToggle: () => void;
}) {
  const visible = showAll
    ? session.keystrokes
    : session.keystrokes.slice(0, KEYSTROKE_PREVIEW);
  const hidden = session.keystrokes.length - KEYSTROKE_PREVIEW;
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Typed ({session.keystrokes.length} batches)</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {visible.map((batch) => (
          <code
            key={batch.id}
            className="block rounded-md font-sans bg-background/70 px-3 py-2 tabular-nums text-[12.5px] whitespace-pre-wrap text-foreground [word-break:break-word]"
          >
            {batch.keys.slice(0, 400)}
            {batch.keys.length > 400 ? "…" : ""}
          </code>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            className="cursor-pointer self-start text-xs text-muted-foreground hover:text-foreground"
            onClick={onToggle}
          >
            {showAll ? "Show less" : `…and ${hidden} more`}
          </button>
        )}
      </div>
    </div>
  );
}
function SessionDetails({
  session,
  timeline,
  showAll,
  onToggle,
  onOpenScreenshot,
  agentId,
  onActivityDeepLink,
}: Pick<
  SessionRowProps,
  "session" | "onOpenScreenshot" | "agentId" | "onActivityDeepLink"
> & { timeline: MergedActivityRow[]; showAll: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col gap-5 border-t border-border/60 py-4 pr-4 pl-4 sm:pl-[84px]">
      <p className="tabular-nums text-[11.5px] text-muted-foreground">
        {formatTimeRange(session.startTime, session.endTime)} ·{" "}
        {session.appName}
      </p>
      {session.hasKeystrokes && (
        <TypedBatches session={session} showAll={showAll} onToggle={onToggle} />
      )}
      {timeline.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>
            Window &amp; page activity ({timeline.length})
          </SectionLabel>
          <div className="flex flex-col">
            {timeline.map((row) => (
              <MergedActivityRowView
                key={mergedRowKey(row)}
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
  );
}
/** One compact session with independently rendered identity, counts and expanded evidence. */
export function SessionRow({
  session,
  highlighted,
  focused,
  onOpenScreenshot,
  onFilterApp,
  agentId,
  onActivityDeepLink,
  showUser = true,
}: SessionRowProps) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const forceOpen = focused || highlighted;
  const [prevForceOpen, setPrevForceOpen] = useState(false);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOpen(true);
  }
  const timeline = useMemo(
    () => buildMergedActivityTimeline(session),
    [session],
  );
  const typed = useMemo(() => typedPreview(session), [session]);
  const canExpand = timeline.length > 0 || session.hasKeystrokes;
  if (session.appName === IDLE_APP)
    return (
      <div
        id={`vtl-s-${session.id}`}
        className={cn(
          "flex items-center gap-3 px-3 py-1.5 text-xs text-muted-foreground/70",
          focused && "bg-muted/40",
        )}
      >
        <span className="w-11 shrink-0 text-right tabular-nums sm:w-14">
          {fmtTime(session.startTime)}
        </span>
        <Moon size={12} aria-hidden />
        <span>Idle</span>
        <span>{formatDuration(session.duration)}</span>
      </div>
    );
  return (
    <div
      id={`vtl-s-${session.id}`}
      className={cn(
        "border-l-2 transition-colors",
        open ? "bg-muted/30" : "hover:bg-muted/20",
        forceOpen && "bg-muted/50",
        highlighted && "animate-[vtl-highlight-pulse_1.8s_ease_2]",
      )}
      style={{ borderLeftColor: appColor(session.appName) }}
    >
      <SessionHeading
        session={session}
        highlighted={highlighted}
        showUser={showUser}
        open={open}
        canExpand={canExpand}
        onToggle={() => setOpen((value) => !value)}
        onFilterApp={onFilterApp}
        typed={typed}
      />
      {open && (
        <SessionDetails
          session={session}
          timeline={timeline}
          showAll={showAll}
          onToggle={() => setShowAll((value) => !value)}
          onOpenScreenshot={onOpenScreenshot}
          agentId={agentId}
          onActivityDeepLink={onActivityDeepLink}
        />
      )}
    </div>
  );
}
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground/60 uppercase">
      {children}
    </p>
  );
}
