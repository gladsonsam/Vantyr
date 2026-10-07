import { useMemo, useState } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Globe,
  Keyboard,
  Lock,
  Moon,
  type LucideIcon,
} from "lucide-react";
import { AppIcon } from "@/components/common/AppIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

  const accent = isIdle
    ? "var(--vtl-border)"
    : session.hasKeystrokes
      ? session.hasUrls
        ? "var(--vtl-accent)"
        : "var(--vtl-success)"
      : session.hasUrls
        ? "var(--vtl-accent)"
        : "var(--vtl-border)";

  const highlightStyle: React.CSSProperties = highlighted
    ? {
      outline: "2px solid var(--success)",
      outlineOffset: 2,
      borderRadius: 8,
      boxShadow: "0 0 0 6px var(--ui-border)",
      animation: "vtl-highlight-pulse 1.8s ease 2",
    }
    : {};

  return (
    <div className="vtl-item">
      {/* Left: timestamp */}
      <div className="vtl-timestamp">
        <span className="vtl-time">{fmtTime(session.startTime)}</span>
        <span className="vtl-dur">{formatDuration(session.duration)}</span>
        {highlighted && (
          <span className="vtl-alert-pin" title="Notification fired near this time">
            <Bell size={10} />
          </span>
        )}
      </div>

      {/* Center: dot + line */}
      <div className="vtl-spine">
        <div
          className="vtl-dot"
          style={{
            borderColor: highlighted ? "var(--success)" : accent,
            boxShadow: highlighted
              ? "0 0 0 4px var(--ui-border)"
              : "0 0 0 3px var(--ui-border)",
            opacity: isIdle ? 0.55 : 1,
            transform: highlighted ? "scale(1.3)" : undefined,
          }}
        />
        {!isLast && <div className="vtl-rail" />}
      </div>

      {/* Right: card */}
      <div
        className={`vtl-card${isIdle ? " vtl-card--idle" : ""}${isIdle && !isOpen ? " vtl-card--idle-compact" : ""}${isLockScreen ? " vtl-card--lockscreen" : ""
          }`}
        style={highlightStyle}
      >
        <div
          className="vtl-card-header"
          onClick={() => {
            if (canExpand) {
              setUserToggled(true);
              setExpanded((v) => !v);
            }
          }}
          style={{ cursor: canExpand ? "pointer" : "default" }}
          role={canExpand ? "button" : undefined}
          tabIndex={canExpand ? 0 : undefined}
          onKeyDown={(e) => {
            if (canExpand && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              setUserToggled(true);
              setExpanded((v) => !v);
            }
          }}
        >
          <div className="vtl-card-main" style={{ gap: "4px" }}>
            <div className="vtl-card-title" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {isIdle && <Moon size={14} />}
              {!isIdle ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (session.appName) onFilterApp(session.appName);
                    }}
                    title="Filter timeline by this app"
                    className={isLockScreen ? "vtl-app-chip vtl-app-chip--lockscreen" : "vtl-app-chip"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      // minHeight keeps the chip a 24px touch target without adding
                      // visual bulk on desktop: the padding stays 2px and the extra
                      // height is transparent.
                      minHeight: 24,
                      padding: "2px 8px 2px 6px",
                      borderRadius: 999,
                      border: "1px solid var(--vtl-border)",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {isLockScreen ? <Lock size={12} /> : null}
                    {session.agentId ? <AppIcon agentId={session.agentId} exeName={session.appName} size={14} /> : null}
                    <span>{session.appDisplayName || session.appName}</span>
                  </button>
                  {session.user ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1px solid var(--ui-border)",
                        background: "var(--muted)",
                        color: "var(--muted-foreground)",
                        fontSize: 11,
                        fontWeight: 500,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {session.user}
                    </span>
                  ) : null}
                </>
              ) : (
                <span>Idle</span>
              )}
              {highlighted && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    color: "var(--vtl-accent)",
                    fontSize: 11,
                  }}
                >
                  <Bell size={11} /> Alert fired
                </span>
              )}
            </div>
            {!isIdle && session.windowTitle && session.windowTitle !== session.appName ? (
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: "var(--foreground)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {session.windowTitle}
              </div>
            ) : isIdle ? (
              <div style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 2 }}>
                No activity
              </div>
            ) : null}
            {!isIdle && (
              <div style={{ fontSize: "11px", color: "var(--muted-foreground)", marginTop: 1 }} className="font-mono">
                {isLockScreen ? null : session.appName}
              </div>
            )}
            <div className="vtl-card-meta">
              <span className="vtl-meta-time">{formatTimeRange(session.startTime, session.endTime)}</span>
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
            <span className="vtl-chevron">
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          )}
        </div>

        {isOpen && (
          <div className="vtl-card-body">
            {mergedTimeline.length > 0 && (
              <div className="vtl-section">
                <p className="vtl-section-label">Timeline ({mergedTimeline.length})</p>
                <div className="vtl-merged-timeline">
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
              <div className="vtl-section">
                <p className="vtl-section-label">Keystrokes ({session.keystrokes.length} sessions)</p>
                <div className="vtl-key-list">
                  {(showAllKeystrokes ? session.keystrokes : session.keystrokes.slice(0, 3)).map((ks, i) => (
                    <code key={i} className="vtl-key-block">
                      {ks.keys.slice(0, 80)}
                      {ks.keys.length > 80 ? "…" : ""}
                    </code>
                  ))}
                  {session.keystrokes.length > 3 && !showAllKeystrokes && (
                    <button
                      type="button"
                      className="vtl-more"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAllKeystrokes(true);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        color: "inherit",
                        textAlign: "left",
                        font: "inherit",
                        opacity: 0.75,
                      }}
                    >
                      …and {session.keystrokes.length - 3} more (click to expand)
                    </button>
                  )}
                  {session.keystrokes.length > 3 && showAllKeystrokes && (
                    <button
                      type="button"
                      className="vtl-more"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAllKeystrokes(false);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        color: "inherit",
                        textAlign: "left",
                        font: "inherit",
                        opacity: 0.75,
                      }}
                    >
                      Show less
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
