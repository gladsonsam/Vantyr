import AppLayout from "@cloudscape-design/components/app-layout";
import Flashbar from "@cloudscape-design/components/flashbar";
import clsx from "clsx";
import { TopNav } from "../components/navigation/TopNav";
import { useState } from "react";
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
  /** Admin: alerts (rules + history). */
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
  contentType = "default",
  notifications,
  onDismissNotification,
  showTools = false,
  toolsOpen = false,
  onToolsChange,
}: DashboardLayoutProps) {
  const [navigationOpen, setNavigationOpen] = useState(true);
  const { pathname } = useLocation();
  const onBackToOverview = pathname !== "/" ? onGoHome : undefined;
  const hasNavigation = Boolean(navigation);
  const isAgentDetail = pathname.startsWith("/agents/");

  return (
    <div className="sentinel-dashboard-shell">
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
      <AppLayout
        navigation={navigation}
        navigationOpen={hasNavigation && navigationOpen}
        navigationHide={!hasNavigation}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        notifications={
          <Flashbar
            items={notifications.map((n) => ({
              ...n,
              onDismiss: () => onDismissNotification(n.id),
            }))}
          />
        }
        content={
          <div
            className={clsx(
              "sentinel-dashboard-main",
              isAgentDetail && "sentinel-dashboard-main--agent-detail",
            )}
          >
            {content}
          </div>
        }
        navigationWidth={280}
        toolsHide={!showTools}
        tools={showTools ? <ToolsContent /> : undefined}
        toolsOpen={showTools && toolsOpen}
        onToolsChange={({ detail }) => onToolsChange?.(detail.open)}
        contentType={contentType}
      />
    </div>
  );
}
