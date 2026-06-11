import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import type { NotificationItem } from "../hooks/useNotifications";
import type { DashboardNavUser } from "../lib/types";
import { VI } from "../components/common/Icons";
import { DashboardUserAvatar } from "../components/common/DashboardUserAvatar";

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
}: DashboardLayoutProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Collapsible sidebar state
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem("sidebar-collapsed");
      return saved === "true";
    } catch {
      return false;
    }
  });

  const handleToggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  };

  // Nav items matching vantyr-shared.jsx
  const mainNav = [
    { label: "Agents", path: "/", icon: VI.agents },
    ...(onOpenNotifications
      ? [{ label: "Alerts", path: "/rules", icon: VI.alerts }]
      : []),
    ...(onOpenActivityLog
      ? [{ label: "Audit log", path: "/logs", icon: VI.audit }]
      : []),
  ];

  const systemNav = [
    { label: "Settings", path: "/settings", icon: VI.sliders },
  ];

  // User Dropdown open state
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOut = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    if (userMenuOpen) {
      document.addEventListener("click", onClickOut);
    }
    return () => document.removeEventListener("click", onClickOut);
  }, [userMenuOpen]);

  // Page Header Details
  let pageTitle = "Dashboard";
  let pageSub = "";

  if (pathname === "/") {
    pageTitle = "Agents";
    pageSub = "Fleet summary and live statuses";
  } else if (pathname.startsWith("/agents/")) {
    pageTitle = "Agent Details";
    pageSub = "Live streaming and surveillance";
  } else if (pathname === "/rules" || pathname === "/notifications") {
    pageTitle = "Alerts & Rules";
    pageSub = "Triggers and active rule policies";
  } else if (pathname === "/logs") {
    pageTitle = "Audit Log";
    pageSub = "System activity and command tracking";
  } else if (pathname === "/settings") {
    pageTitle = "Settings";
    pageSub = "Application and telemetry configuration";
  } else if (pathname === "/groups") {
    pageTitle = "Agent Groups";
    pageSub = "Organize and manage fleet permissions";
  } else if (pathname === "/users") {
    pageTitle = "User Management";
    pageSub = "Administrators and operators roster";
  }

  const handleNav = (path: string) => {
    if (path === "/") onGoHome();
    else navigate(path);
  };

  return (
    <div
      style={{
        display: "flex",
        width: "100vw",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--tx)",
        fontFamily: "var(--font)",
        overflow: "hidden",
      }}
    >
      {/* Collapsible Sidebar */}
      <div
        style={{
          width: collapsed ? 68 : 222,
          flexShrink: 0,
          background: "var(--bg-soft)",
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          transition: "width .18s ease",
        }}
      >
        {/* Brand logo & Beta tag */}
        <div
          onClick={handleToggle}
          style={{
            height: 64,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: collapsed ? "0" : "0 20px",
            justifyContent: collapsed ? "center" : "flex-start",
            cursor: "pointer",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <img
            src="/logo.svg"
            alt="Vantyr Logo"
            style={{ width: 22, height: 22, flexShrink: 0 }}
          />
          {!collapsed && (
            <>
              <span
                style={{
                  fontSize: 17,
                  fontWeight: 700,
                  fontFamily: "var(--display)",
                  color: "var(--tx)",
                  letterSpacing: "-0.01em",
                  height: "25px",
                  lineHeight: "25px",
                }}
              >
                Vantyr
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: "var(--gr)",
                  background: "var(--gr-soft)",
                  padding: "2px 6px",
                  borderRadius: 5,
                  marginTop: 1,
                }}
              >
                BETA
              </span>
            </>
          )}
        </div>

        {/* Main Nav Items */}
        <div
          style={{
            padding: collapsed ? "6px 10px" : "6px 12px",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginTop: 12,
          }}
        >
          {mainNav.map((item) => {
            const on = pathname === item.path || (item.path !== "/" && pathname.startsWith(item.path));
            return (
              <div
                key={item.label}
                onClick={() => handleNav(item.path)}
                title={collapsed ? item.label : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: collapsed ? "10px" : "9px 12px",
                  justifyContent: collapsed ? "center" : "flex-start",
                  borderRadius: 10,
                  cursor: "pointer",
                  background: on ? "var(--gr-soft)" : "transparent",
                  color: on ? "var(--gr)" : "var(--tx-2)",
                  transition: "all 0.15s ease",
                }}
              >
                <item.icon style={{ width: 18, height: 18, flexShrink: 0 }} />
                {!collapsed && (
                  <span style={{ fontSize: 13.5, fontWeight: on ? 600 : 500 }}>
                    {item.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* System & Configuration Nav Section */}
        <div
          style={{
            padding: collapsed ? "6px 10px" : "6px 12px 12px 12px",
            borderTop: "1px solid var(--line)",
          }}
        >
          {collapsed ? (
            <div style={{ height: 1, background: "var(--line)", margin: "6px" }} />
          ) : (
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.12em",
                color: "var(--tx-4)",
                textTransform: "uppercase",
                padding: "12px 12px 8px",
              }}
            >
              System
            </div>
          )}
          {systemNav.map((item) => {
            const on = pathname === item.path || pathname.startsWith(item.path);
            return (
              <div
                key={item.label}
                onClick={() => handleNav(item.path)}
                title={collapsed ? item.label : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: collapsed ? "10px" : "9px 12px",
                  justifyContent: collapsed ? "center" : "flex-start",
                  borderRadius: 10,
                  cursor: "pointer",
                  background: on ? "var(--gr-soft)" : "transparent",
                  color: on ? "var(--gr)" : "var(--tx-2)",
                  transition: "all 0.15s ease",
                }}
              >
                <item.icon style={{ width: 18, height: 18, flexShrink: 0 }} />
                {!collapsed && (
                  <span style={{ fontSize: 13.5, fontWeight: on ? 600 : 500 }}>
                    {item.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Content Pane */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Content Header TopBar */}
        <div
          style={{
            height: 64,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 26px",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg-soft)",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--tx-3)",
                fontWeight: 600,
                marginBottom: 1,
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {pageSub}
            </div>
            <div
              style={{
                fontSize: 21,
                fontWeight: 600,
                fontFamily: "var(--display)",
                color: "var(--tx)",
                letterSpacing: "-0.02em",
              }}
            >
              {pageTitle}
            </div>
          </div>

          {/* User Account / Navigation controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div ref={userMenuRef} style={{ position: "relative" }}>
              <div
                onClick={() => setUserMenuOpen((o) => !o)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "6px 12px 6px 7px",
                  borderRadius: 99,
                  border: "1px solid var(--line-2)",
                  cursor: "pointer",
                  background: "var(--card)",
                  userSelect: "none",
                }}
              >
                {currentUser ? (
                  <DashboardUserAvatar
                    username={currentUser.username}
                    displayName={currentUser.display_name}
                    displayIcon={currentUser.display_icon}
                    size={28}
                  />
                ) : (
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: "linear-gradient(135deg,#2a2d33,#16181c)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 700,
                      color: "var(--tx-2)",
                    }}
                  >
                    AC
                  </div>
                )}
                <div>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: "var(--tx)",
                      lineHeight: 1.15,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {currentUser
                      ? currentUser.display_name?.trim() || currentUser.username
                      : "Account"}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--tx-3)",
                      textTransform: "capitalize",
                    }}
                  >
                    {currentUser?.role || "user"}
                  </div>
                </div>
              </div>

              {/* User Dropdown */}
              {userMenuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: 8,
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    minWidth: 200,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                    zIndex: 1000,
                    overflow: "hidden",
                  }}
                >
                  {onOpenUsers && (
                    <div
                      onClick={() => {
                        onOpenUsers();
                        setUserMenuOpen(false);
                      }}
                      className="dropdown-item"
                      style={{
                        padding: "10px 14px",
                        cursor: "pointer",
                        fontSize: 13,
                        color: "var(--tx-2)",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <VI.agents style={{ width: 15, height: 15 }} />
                      User Accounts
                    </div>
                  )}
                  <div
                    onClick={() => {
                      onShowPreferences();
                      setUserMenuOpen(false);
                    }}
                    className="dropdown-item"
                    style={{
                      padding: "10px 14px",
                      cursor: "pointer",
                      fontSize: 13,
                      color: "var(--tx-2)",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <VI.sliders style={{ width: 15, height: 15 }} />
                    Settings
                  </div>
                  <div style={{ height: "1px", background: "var(--line)", margin: "6px 0" }} />
                  <div
                    onClick={() => {
                      onLogout();
                      setUserMenuOpen(false);
                    }}
                    className="dropdown-item"
                    style={{
                      padding: "10px 14px",
                      cursor: "pointer",
                      fontSize: 13,
                      color: "var(--red)",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <VI.x style={{ width: 15, height: 15 }} />
                    Logout
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Global Notifications */}
        {notifications.length > 0 && (
          <div
            style={{
              padding: "12px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              background: "var(--bg-soft)",
              borderBottom: "1px solid var(--line)",
            }}
          >
            {notifications.map((n) => (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "var(--r-sm)",
                  background: "var(--card)",
                  border: "1px solid var(--line-2)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      background:
                        n.type === "success"
                          ? "var(--gr)"
                          : n.type === "error"
                            ? "var(--red)"
                            : n.type === "warning"
                              ? "var(--amber)"
                              : "var(--blue)",
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                    }}
                  />
                  <strong style={{ fontSize: "12.5px" }}>{n.header}</strong>
                  {n.content && (
                    <span style={{ fontSize: "12px", color: "var(--tx-2)" }}>
                      · {n.content}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {n.action}
                  {n.dismissible !== false && (
                    <button
                      onClick={() => onDismissNotification(n.id)}
                      style={{
                        padding: "2px 8px",
                        fontSize: "11px",
                        height: "auto",
                        background: "var(--card-3)",
                        border: "1px solid var(--line-3)",
                        borderRadius: "5px",
                        color: "var(--tx-2)",
                        cursor: "pointer",
                      }}
                    >
                      {n.dismissLabel || "Dismiss"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Page Main Content Area */}
        <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
          {content}
        </div>
      </div>
      <style>{`
        .dropdown-item:hover {
          background: var(--card-2);
          color: var(--tx) !important;
        }
      `}</style>
    </div>
  );
}
