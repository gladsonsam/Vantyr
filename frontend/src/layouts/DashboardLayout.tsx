import clsx from "clsx";
import { TopNav } from "../components/navigation/TopNav";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { NotificationItem } from "../hooks/useNotifications";
import { ToolsContent } from "../components/detail/ToolsContent";
import type { DashboardNavUser } from "../lib/types";

interface DashboardLayoutProps {
  navigation?: ReactNode;
  content: ReactNode;
  onLogout: () => void;
  onShowPreferences: () => void;
  onOpenActivityLog?: () => void;
  onOpenUsers?: () => void;
  onOpenNotifications?: () => void;
  onGoHome: () => void;
  currentUser?: DashboardNavUser | null;
  contentType?: "default" | "table" | "form" | "cards";
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
  showTools?: boolean;
  toolsOpen?: boolean;
  onToolsChange?: (open: boolean) => void;
}

export function DashboardLayout({
  navigation,
  content,
  onLogout,
  onShowPreferences,
  onOpenActivityLog,
  onOpenUsers,
  onOpenNotifications,
  onGoHome,
  currentUser = null,
  notifications,
  onDismissNotification,
  showTools = false,
  toolsOpen = false,
  onToolsChange,
}: DashboardLayoutProps) {
  const navigationOpen = true;
  const { pathname } = useLocation();
  const onBackToOverview = pathname !== "/" ? onGoHome : undefined;
  const hasNavigation = Boolean(navigation);
  const isAgentDetail = pathname.startsWith("/agents/");

  return (
    <div className="vantyr-dashboard-shell sx" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <TopNav
        onLogout={onLogout}
        onShowPreferences={onShowPreferences}
        onOpenActivityLog={onOpenActivityLog}
        onOpenUsers={onOpenUsers}
        onOpenNotifications={onOpenNotifications}
        onBackToOverview={onBackToOverview}
        onGoHome={onGoHome}
        currentUser={currentUser}
      />
      <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>
        {hasNavigation && navigationOpen && (
          <aside style={{ width: 280, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-2)", display: "flex", flexDirection: "column" }}>
            {navigation}
          </aside>
        )}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--bg)", position: "relative" }}>
          {notifications.length > 0 && (
            <div style={{ padding: "12px 24px", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-2)", borderBottom: "1px solid var(--border)" }}>
              {notifications.map((n) => (
                <div key={n.id} className={`pill ${n.type || "info"}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px", borderRadius: "var(--r-sm)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="dot" style={{ background: n.type === "success" ? "var(--ok)" : n.type === "error" ? "var(--down)" : n.type === "warning" ? "var(--afk)" : "var(--active)", width: 7, height: 7 }} />
                    <strong style={{ fontSize: "12.5px" }}>{n.header}</strong>
                    {n.content && <span style={{ fontSize: "12px", color: "var(--text-2)" }}>· {n.content}</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {n.action}
                    {n.dismissible !== false && (
                      <button onClick={() => onDismissNotification(n.id)} className="btn ghost" style={{ padding: "2px 8px", fontSize: "11px", height: "auto" }}>
                        {n.dismissLabel || "Dismiss"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className={clsx("vantyr-dashboard-main scroller", isAgentDetail && "vantyr-dashboard-main--agent-detail")} style={{ flex: 1 }}>
            {content}
          </div>
        </main>
        {showTools && toolsOpen && (
          <aside className="scroller" style={{ width: 332, flexShrink: 0, borderLeft: "1px solid var(--border)", background: "var(--bg-2)", padding: "20px", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span className="eyebrow">Help & Specs</span>
              <button className="btn ghost" onClick={() => onToolsChange?.(false)} style={{ padding: "4px 8px" }}>×</button>
            </div>
            <ToolsContent />
          </aside>
        )}
      </div>
    </div>
  );
}
