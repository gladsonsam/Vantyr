import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useDashboardViewport, useMobileDrawer, useMobileViewport } from "./useMobileDrawer";
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
  const isMobile = useMobileViewport();
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useDashboardViewport(shellRef);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem("sidebar-collapsed");
      return saved === "true";
    } catch {
      return false;
    }
  });

  const compactSidebar = collapsed && !isMobile;

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
    // Recall (screen-history DVR) — operator/admin only; server endpoints are operator-gated.
    ...(currentUser && currentUser.role !== "viewer"
      ? [{ label: "Recall", path: "/recall", icon: VI.play }]
      : []),
    ...(onOpenNotifications
      ? [{ label: "Alerts", path: "/rules", icon: VI.alerts }]
      : []),
    ...(onOpenActivityLog
      ? [{ label: "Audit log", path: "/logs", icon: VI.audit }]
      : []),
  ];



  const systemNav = [
    { label: "Server settings", path: "/settings", icon: VI.sliders },
  ];

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const closeMobileNav = useCallback(() => setMobileMenuOpen(false), []);
  const openMobileNav = useCallback(() => {
    if (!isMobile) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUserMenuOpen(false);
    setMobileMenuOpen(true);
  }, [isMobile]);
  const drawerOpen = isMobile && mobileMenuOpen;
  useMobileDrawer(drawerOpen, sidebarRef, mainRef, openerRef, closeMobileNav);
  useEffect(() => { if (!isMobile) setMobileMenuOpen(false); }, [isMobile]);

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
  } else if (pathname === "/recall") {
    pageTitle = "Recall";
  } else if (pathname === "/account") {
    pageTitle = "Account settings";
  } else if (pathname === "/settings") {
    pageTitle = "Server settings";
  } else if (pathname === "/groups") {
    pageTitle = "Agent Groups";
  } else if (pathname === "/users") {
    pageTitle = "User Management";
  }

  const handleNav = (path: string) => {
    closeMobileNav();
    if (path === "/") onGoHome();
    else navigate(path);
  };

  const navItem = (item: { label: string; path: string; icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactElement }, active: boolean) => (
    <Link key={item.label} to={item.path} aria-label={item.label} aria-current={active ? "page" : undefined}
      title={compactSidebar ? item.label : undefined} className="dashboard-nav-link"
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); handleNav(item.path);
      }}
      style={{ display: "flex", alignItems: "center", gap: 11, padding: compactSidebar ? "10px" : "9px 12px",
        justifyContent: compactSidebar ? "center" : "flex-start", borderRadius: 10, marginBottom: 2,
        background: active ? "var(--gr-soft)" : "transparent", color: active ? "var(--gr)" : "var(--tx-2)", textDecoration: "none" }}>
      <item.icon aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0 }} />
      {!compactSidebar && <span style={{ fontSize: 13.5, fontWeight: active ? 600 : 500 }}>{item.label}</span>}
    </Link>
  );

  return (
    <div
      ref={shellRef}
      className="dashboard-shell"
      style={{
        display: "flex",
        width: "100vw",
        background: "var(--bg)",
        color: "var(--tx)",
        fontFamily: "var(--font)",
        overflow: "hidden",
      }}
    >
      {/* Mobile Backdrop overlay */}
      {drawerOpen && (
        <div
          className="dashboard-mobile-backdrop"
          aria-hidden="true"
          onClick={closeMobileNav}
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
      <aside
        ref={sidebarRef} id="dashboard-navigation" tabIndex={-1}
        role={drawerOpen ? "dialog" : undefined} aria-modal={drawerOpen || undefined}
        aria-label="Main navigation" hidden={isMobile && !drawerOpen} inert={isMobile && !drawerOpen}
        className={`dashboard-sidebar ${drawerOpen ? "mobile-open" : ""}`}
        style={{
          width: compactSidebar ? 68 : 222,
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
        <div className="dashboard-sidebar-brand"
          style={{
            height: 64,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: compactSidebar ? "0" : "0 20px",
            justifyContent: compactSidebar ? "center" : "flex-start",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <button type="button" className="dashboard-collapse-toggle" hidden={isMobile} onClick={handleToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls="dashboard-navigation">
            <VI.logo aria-hidden="true" style={{ width: 22, height: 22 }} />
          </button>
          {isMobile && <VI.logo aria-hidden="true" style={{ width: 22, height: 22, color: "var(--gr)" }} />}
          {!compactSidebar && (
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
          )}
        </div>

        {isMobile && <button type="button" className="dashboard-drawer-close" onClick={closeMobileNav} aria-label="Close navigation">Close <VI.x aria-hidden="true" style={{ width: 18, height: 18 }} /></button>}
        {/* Main nav */}
        <nav aria-label="Main"
          style={{
            padding: compactSidebar ? "6px 10px" : "6px 12px",
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
              return navItem(item, on);
            })}
          </div>

        </nav>

        {/* System section */}
        <nav aria-label="System"
          style={{
            padding: compactSidebar ? "6px 10px" : "6px 12px",
            borderTop: "1px solid var(--line)",
          }}
        >
          {!compactSidebar && (
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
            return navItem(item, on);
          })}
        </nav>
      </aside>

      {/* Main content pane */}
      <div ref={mainRef} className="dashboard-main" tabIndex={-1} inert={drawerOpen} aria-hidden={drawerOpen || undefined}
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
            <div className="dashboard-topbar-title" style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              {/* Mobile menu toggle */}
              <button
                type="button"
                onClick={openMobileNav}
                aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="dashboard-navigation"
                className="mobile-menu-toggle"
                style={{
                  display: "none",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 44,
                  height: 44,
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
            <div className="dashboard-topbar-actions" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {topBarActions}
              <div ref={userMenuRef} style={{ position: "relative" }}>
                <button type="button" className="dashboard-account-trigger" aria-label="Account options" aria-expanded={userMenuOpen}
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
                </button>

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
                    <button type="button"
                      onClick={() => { onShowPreferences(); setUserMenuOpen(false); }}
                      className="dropdown-item"
                      style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--tx-2)", display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <VI.sliders style={{ width: 15, height: 15 }} />
                      Account settings
                    </button>
                    {onOpenUsers && currentUser?.role === "admin" && (
                      <button type="button"
                        onClick={() => { onOpenUsers(); setUserMenuOpen(false); }}
                        className="dropdown-item"
                        style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--tx-2)", display: "flex", alignItems: "center", gap: 8 }}
                      >
                        <VI.agents style={{ width: 15, height: 15 }} />
                        User Accounts
                      </button>
                    )}
                    <div style={{ height: "1px", background: "var(--line)", margin: "6px 0" }} />
                    <button type="button"
                      onClick={() => { onLogout(); setUserMenuOpen(false); }}
                      className="dropdown-item"
                      style={{ padding: "10px 14px", cursor: "pointer", fontSize: 13, color: "var(--red)", display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <VI.x style={{ width: 15, height: 15 }} />
                      Logout
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Global notifications */}
        {notifications.length > 0 && (
          <div
            className="vantyr-notifications"
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
                className="vantyr-notification"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  // wrap + minWidth:0 so the message column shrinks and the actions
                  // stay inside the row on a narrow viewport instead of overflowing.
                  // wrap + minWidth:0 so the message column shrinks and the actions
                  // stay inside the row on a narrow viewport instead of overflowing.
                  flexWrap: "wrap",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "var(--r-sm)",
                  background: "var(--card)",
                  border: "1px solid var(--line-2)",
                }}
              >
                {/* The severity dot is its own non-shrinking flex item, and the text
                    is a block that flows normally. Keeping header+content as
                    separate flex items made each one shrink to its minimum and
                    wrap one word per line on a narrow viewport. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    minWidth: 0,
                    flex: "1 1 160px",
                  }}
                >
                  <div
                    style={{
                      background:
                        n.type === "success" ? "var(--gr)" :
                        n.type === "error" ? "var(--red)" :
                        n.type === "warning" ? "var(--amber)" : "var(--blue)",
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      marginTop: 5,
                      flexShrink: 0,
                    }}
                  />
                  {/* `overflow-wrap: anywhere` alone lets a long header shatter to
                      one character per line when the row wraps on a narrow
                      viewport; break-word only breaks when a word can't fit. */}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong
                      style={{
                        fontSize: "12.5px",
                        overflowWrap: "break-word",
                        minWidth: 0,
                      }}
                    >
                      {n.header}
                    </strong>
                    {n.content && (
                      <span
                        style={{
                          fontSize: "12px",
                          color: "var(--tx-2)",
                          overflowWrap: "break-word",
                        }}
                      >
                        · {n.content}
                      </span>
                    )}
                  </div>
                </div>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}
                >
                  {n.action}
                  {n.dismissible !== false && (
                    <button
                      type="button"
                      onClick={() => onDismissNotification(n.id)}
                      style={{
                        padding: "2px 8px",
                        fontSize: "11px",
                        // 24px touch target without changing the compact visual size.
                        minHeight: 24,
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
        <main className="dashboard-content" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto", position: "relative" }}>
          <MobileNavContext.Provider value={openMobileNav}>
            {content}
          </MobileNavContext.Provider>
        </main>
      </div>


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

