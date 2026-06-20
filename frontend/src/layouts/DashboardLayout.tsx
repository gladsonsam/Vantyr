import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import type { NotificationItem } from "../hooks/useNotifications";
import type { DashboardNavUser } from "../lib/types";
import { VI } from "../components/common/Icons";
import { DashboardUserAvatar } from "../components/common/DashboardUserAvatar";

/**
 * Lets nested pages open the mobile nav drawer even when they hide the top bar
 * (e.g. the agent detail page, which has its own header). `null` when not inside
 * a DashboardLayout.
 */
const MobileNavContext = createContext<(() => void) | null>(null);

/** Returns a callback that opens the mobile nav drawer, or null if unavailable. */
export function useMobileNavOpener(): (() => void) | null {
  return useContext(MobileNavContext);
}

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
  /** Custom actions rendered right of the page title, left of the user pill */
  topBarActions?: ReactNode;
  /** Replaces the left side (title/subtitle) of the top bar entirely */
  topBarLeft?: ReactNode;
  /** Secondary sub-text shown above the page title (e.g. "7 enrolled · 4 online") */
  pageSub2?: string;
  /** When true, hides the top bar entirely (agent detail uses its own header) */
  hideTopBar?: boolean;
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
  topBarActions,
  topBarLeft,
  pageSub2,
  hideTopBar = false,
}: DashboardLayoutProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

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
      } catch {
        // ignore
      }
      return next;
    });
  };

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

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const openMobileNav = useCallback(() => setMobileMenuOpen(true), []);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onClickOut = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    if (userMenuOpen) document.addEventListener("click", onClickOut);
    return () => document.removeEventListener("click", onClickOut);
  }, [userMenuOpen]);

  let pageTitle = "Dashboard";

  if (pathname === "/") {
    pageTitle = "Agents";
  } else if (pathname.startsWith("/agents/")) {
    pageTitle = "Agent Details";
  } else if (pathname === "/rules" || pathname === "/notifications") {
    pageTitle = "Alerts & Rules";
  } else if (pathname === "/logs") {
    pageTitle = "Audit Log";
  } else if (pathname === "/settings") {
    pageTitle = "Settings";
  } else if (pathname === "/groups") {
    pageTitle = "Agent Groups";
  } else if (pathname === "/users") {
    pageTitle = "User Management";
  }

  const handleNav = (path: string) => {
    if (path === "/") onGoHome();
    else navigate(path);
  };

  const NavItem = ({
    item,
    active,
  }: {
    item: { label: string; path: string; icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactElement };
    active: boolean;
  }) => (
    <div
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
        marginBottom: 2,
        background: active ? "var(--gr-soft)" : "transparent",
        color: active ? "var(--gr)" : "var(--tx-2)",
        transition: "all 0.15s ease",
      }}
    >
      <item.icon style={{ width: 18, height: 18, flexShrink: 0 }} />
      {!collapsed && (
        <span style={{ fontSize: 13.5, fontWeight: active ? 600 : 500 }}>
          {item.label}
        </span>
      )}
    </div>
  );

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
      {/* Mobile Backdrop overlay */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(4px)",
            zIndex: 998,
            animation: "vfade 0.2s ease",
          }}
        />
      )}

      {/* Sidebar */}
      <div
        className={`dashboard-sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}
        style={{
          width: collapsed ? 68 : 222,
          flexShrink: 0,
          background: "var(--bg-soft)",
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          transition: "all .18s ease",
        }}
      >
        {/* Logo */}
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
          <div style={{ color: "var(--gr)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <VI.logo style={{ width: 22, height: 22, flexShrink: 0 }} />
          </div>
          {!collapsed && (
            <>
              <span
                style={{
                  fontSize: 17,
                  fontWeight: 700,
                  fontFamily: "var(--display)",
                  color: "var(--tx)",
                  letterSpacing: "-0.01em",
                  lineHeight: "25px",
                  height: "25px",
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

        {/* Main nav */}
        <div
          style={{
            padding: collapsed ? "6px 10px" : "6px 12px",
            flex: 1,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ marginTop: 6 }}>
            {mainNav.map((item) => {
              const on =
                pathname === item.path ||
                (item.path !== "/" && pathname.startsWith(item.path));
              return <NavItem key={item.label} item={item} active={on} />;
            })}
          </div>

        </div>

        {/* System section */}
        <div
          style={{
            padding: collapsed ? "6px 10px" : "6px 12px",
            borderTop: "1px solid var(--line)",
          }}
        >
          {!collapsed && (
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.12em",
                color: "var(--tx-4)",
                textTransform: "uppercase",
                padding: "10px 12px 6px",
              }}
            >
              System
            </div>
          )}
          {systemNav.map((item) => {
            const on = pathname === item.path || pathname.startsWith(item.path);
            return <NavItem key={item.label} item={item} active={on} />;
          })}
        </div>
      </div>

      {/* Main content pane */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        {/* TopBar */}
        {!hideTopBar && (
          <div
            className="dashboard-topbar"
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
            {/* Left side */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              {/* Mobile menu toggle */}
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="mobile-menu-toggle"
                style={{
                  display: "none",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: "var(--card)",
                  border: "1px solid var(--line-2)",
                  color: "var(--tx-2)",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" />
                  <line x1="3" y1="6" x2="21" y2="6" stroke="currentColor" />
                  <line x1="3" y1="18" x2="21" y2="18" stroke="currentColor" />
                </svg>
              </button>

              {topBarLeft ? (
                topBarLeft
              ) : (
                <div style={{ minWidth: 0 }}>
                  {pageSub2 && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--tx-3)",
                        fontWeight: 600,
                        marginBottom: 1,
                        textOverflow: "ellipsis",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {pageSub2}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 21,
                      fontWeight: 600,
                      fontFamily: "var(--display)",
                      color: "var(--tx)",
                      letterSpacing: "-0.02em",
                      textOverflow: "ellipsis",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pageTitle}
                  </div>
                </div>
              )}
            </div>

            {/* Right side */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {topBarActions}
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
                  <div className="topbar-user-text">
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
                        onClick={() => { onOpenUsers(); setUserMenuOpen(false); }}
                        className="dropdown-item"
                        style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--tx-2)", display: "flex", alignItems: "center", gap: 8 }}
                      >
                        <VI.agents style={{ width: 15, height: 15 }} />
                        User Accounts
                      </div>
                    )}
                    <div
                      onClick={() => { onShowPreferences(); setUserMenuOpen(false); }}
                      className="dropdown-item"
                      style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--tx-2)", display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <VI.sliders style={{ width: 15, height: 15 }} />
                      Settings
                    </div>
                    <div style={{ height: "1px", background: "var(--line)", margin: "6px 0" }} />
                    <div
                      onClick={() => { onLogout(); setUserMenuOpen(false); }}
                      className="dropdown-item"
                      style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--red)", display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <VI.x style={{ width: 15, height: 15 }} />
                      Logout
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Global notifications */}
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
                        n.type === "success" ? "var(--gr)" :
                        n.type === "error" ? "var(--red)" :
                        n.type === "warning" ? "var(--amber)" : "var(--blue)",
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
                      type="button"
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

        {/* Page content */}
        <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
          <MobileNavContext.Provider value={openMobileNav}>
            {content}
          </MobileNavContext.Provider>
        </div>
      </div>

      <style>{`
        .dropdown-item:hover {
          background: var(--card-2) !important;
          color: var(--tx) !important;
        }

        @media (max-width: 768px) {
          .dashboard-sidebar {
            position: fixed !important;
            top: 0;
            left: 0;
            bottom: 0;
            width: 240px !important;
            transform: translateX(-100%);
            z-index: 999;
            box-shadow: 0 0 20px rgba(0,0,0,0.8);
            transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
          }

          .dashboard-sidebar.mobile-open {
            transform: translateX(0) !important;
          }

          .mobile-menu-toggle {
            display: flex !important;
          }

          .dashboard-topbar {
            padding: 12px 14px !important;
          }
        }

        @media (max-width: 520px) {
          .topbar-user-text {
            display: none;
          }
          .dashboard-topbar {
            padding: 12px 12px !important;
          }
        }
      `}</style>
    </div>
  );
}

export function LoadContent({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        minHeight: "300px",
        height: "100%",
        width: "100%",
        color: "var(--tx-3)",
        fontFamily: "var(--font)",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "3px solid var(--line-2)",
          borderTopColor: "var(--gr)",
          animation: "vtl-spin 0.85s linear infinite",
        }}
      />
      <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.02em" }}>{label}</div>
    </div>
  );
}

