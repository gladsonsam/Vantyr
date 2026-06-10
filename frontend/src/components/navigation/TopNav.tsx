import clsx from "clsx";
import { Activity, BellRing, ChevronDown, ChevronLeft, Home, LogOut, Settings, Shield, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { usePollDashboardServerVersion } from "../../hooks/usePollDashboardServerVersion";
import { useServerVersionPayload } from "../../lib/serverVersionStore";
import { dashboardRoleLabel, type DashboardNavUser } from "../../lib/types";
import { DashboardUserAvatar } from "../common/DashboardUserAvatar";

interface TopNavProps {
  onLogout: () => void;
  onShowPreferences: () => void;
  /** Opens the central activity / audit log page. */
  onOpenActivityLog?: () => void;
  onOpenUsers?: () => void;
  /** Admin: alerts (rules + history). */
  onOpenNotifications?: () => void;
  onBackToOverview?: () => void;
  /** Clicking the Vantyr logo/title returns here (usually agent overview). */
  onGoHome: () => void;
  currentUser?: DashboardNavUser | null;
}

type MenuAction = "users" | "notifications" | "activity_log" | "settings" | "logout";
type NavIcon = typeof Settings;

export function TopNav({
  onLogout,
  onShowPreferences,
  onOpenActivityLog,
  onOpenUsers,
  onOpenNotifications,
  onBackToOverview,
  onGoHome,
  currentUser = null,
}: TopNavProps) {
  usePollDashboardServerVersion();
  const versionPayload = useServerVersionPayload();
  const { pathname } = useLocation();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  const account = useMemo(() => {
    const updateAvailable = versionPayload?.server_update_available ?? false;
    const versionLabel = versionPayload?.server_version ?? null;
    const releasesUrlRaw = versionPayload?.releases_url?.trim() ?? "";
    const remoteVersion = versionPayload?.latest_server_release ?? null;
    const hasData = versionLabel != null;
    const canOpenReleases =
      hasData && (releasesUrlRaw.startsWith("https://") || releasesUrlRaw.startsWith("http://"));
    const displayName = currentUser ? currentUser.display_name?.trim() || currentUser.username : "Account";
    const roleLabel = currentUser ? dashboardRoleLabel(currentUser.role) : null;
    const withVPrefix = (v: string | null | undefined) => {
      if (v == null) return "";
      const trimmed = String(v).trim().replace(/^v/i, "");
      return trimmed ? `v${trimmed}` : "";
    };

    return {
      canOpenReleases,
      displayName,
      hasData,
      releasesUrlRaw,
      remoteVersion,
      roleLabel,
      updateAvailable,
      versionLabel,
      withVPrefix,
    };
  }, [currentUser, versionPayload]);

  useEffect(() => {
    if (!accountOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [accountOpen]);

  const runMenuAction = (action: MenuAction) => {
    setAccountOpen(false);
    if (action === "users") onOpenUsers?.();
    else if (action === "notifications") onOpenNotifications?.();
    else if (action === "activity_log") onOpenActivityLog?.();
    else if (action === "settings") onShowPreferences();
    else if (action === "logout") onLogout();
  };

  const directNav: { id: string; label: string; icon: NavIcon; active: boolean; onClick: () => void }[] = [
    { id: "fleet", label: "Fleet", icon: Home, active: pathname === "/", onClick: onGoHome },
    ...(onOpenNotifications
      ? [
          {
            id: "rules",
            label: "Rules",
            icon: BellRing,
            active: pathname === "/rules" || pathname === "/notifications",
            onClick: onOpenNotifications,
          },
        ]
      : []),
    ...(onOpenActivityLog
      ? [
          {
            id: "activity",
            label: "Activity log",
            icon: Activity,
            active: pathname === "/logs",
            onClick: onOpenActivityLog,
          },
        ]
      : []),
    { id: "settings", label: "Settings", icon: Settings, active: pathname === "/settings", onClick: onShowPreferences },
  ];

  const menuItems: { id: MenuAction; label: string; icon: NavIcon; danger?: boolean }[] = [
    ...(onOpenUsers ? [{ id: "users" as const, label: "Users", icon: Users }] : []),
    ...(onOpenNotifications ? [{ id: "notifications" as const, label: "Rules", icon: BellRing }] : []),
    ...(onOpenActivityLog ? [{ id: "activity_log" as const, label: "Activity log", icon: Activity }] : []),
    { id: "settings", label: "Settings", icon: Settings },
    { id: "logout", label: "Logout", icon: LogOut, danger: true },
  ];

  return (
    <div id="vantyr-top-nav" className="vantyr-top-nav sx-console">
      <button type="button" className="vantyr-top-nav__brand" onClick={onGoHome}>
        <span className="vantyr-top-nav__mark" aria-hidden="true">
          <Shield size={15} />
        </span>
        <span className="vantyr-top-nav__title">Vantyr</span>
      </button>

      <nav className="vantyr-top-nav__links" aria-label="Dashboard">
        {directNav.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={clsx("vantyr-top-nav__link", item.active && "vantyr-top-nav__link--active")}
              onClick={item.onClick}
              aria-current={item.active ? "page" : undefined}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="vantyr-top-nav__actions">
        {onBackToOverview ? (
          <button type="button" className="vantyr-top-nav__back" onClick={onBackToOverview}>
            <ChevronLeft size={15} aria-hidden="true" />
            <span>Overview</span>
          </button>
        ) : null}

        <div className="vantyr-top-nav__account" ref={accountRef}>
          <button
            type="button"
            className={clsx(
              "vantyr-top-nav__account-trigger",
              account.updateAvailable && account.versionLabel != null && "vantyr-top-nav__account-trigger--update",
            )}
            onClick={() => setAccountOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
          >
            {currentUser ? (
              <DashboardUserAvatar
                username={currentUser.username}
                displayName={currentUser.display_name}
                displayIcon={currentUser.display_icon}
                size={26}
                className="vantyr-top-nav-account-avatar"
              />
            ) : (
              <span className="vantyr-top-nav__fallback-avatar" aria-hidden="true">
                AC
              </span>
            )}
            <span className="vantyr-top-nav__account-copy">
              <span className="vantyr-top-nav__account-name">{account.displayName}</span>
              {account.roleLabel ? <span className="vantyr-top-nav__account-role">{account.roleLabel}</span> : null}
            </span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>

          {accountOpen ? (
            <div className="vantyr-top-nav__account-menu" role="menu">
              <div
                className={clsx(
                  "vantyr-account-menu-version",
                  account.updateAvailable && account.hasData && "vantyr-account-menu-version--update",
                  !account.hasData && "vantyr-account-menu-version--loading",
                )}
              >
                <div className="vantyr-account-menu-version__head">
                  <div className="vantyr-account-menu-version__titles">
                    <div className="vantyr-account-menu-version__account-name">{account.displayName}</div>
                    {account.roleLabel ? (
                      <div className="vantyr-account-menu-version__account-role">{account.roleLabel}</div>
                    ) : null}
                    {account.hasData ? (
                      <div className="vantyr-account-menu-version__server-ver">
                        {account.withVPrefix(account.versionLabel)}
                      </div>
                    ) : (
                      <span className="vantyr-account-menu-version__muted">Checking version...</span>
                    )}
                  </div>
                  {account.hasData ? (
                    <div className="vantyr-account-menu-version__actions">
                      {account.updateAvailable ? (
                        account.canOpenReleases ? (
                          <a
                            href={account.releasesUrlRaw}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={clsx(
                              "vantyr-account-menu-version__pill",
                              account.remoteVersion != null && "vantyr-account-menu-version__pill--stack",
                            )}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <span className="vantyr-account-menu-version__pill-line">Update available</span>
                            {account.remoteVersion != null ? (
                              <span className="vantyr-account-menu-version__pill-sub">
                                {account.withVPrefix(account.remoteVersion)}
                              </span>
                            ) : null}
                          </a>
                        ) : (
                          <span
                            className={clsx(
                              "vantyr-account-menu-version__pill",
                              account.remoteVersion != null && "vantyr-account-menu-version__pill--stack",
                            )}
                          >
                            <span className="vantyr-account-menu-version__pill-line">Update available</span>
                            {account.remoteVersion != null ? (
                              <span className="vantyr-account-menu-version__pill-sub">
                                {account.withVPrefix(account.remoteVersion)}
                              </span>
                            ) : null}
                          </span>
                        )
                      ) : (
                        <span className="vantyr-account-menu-version__ok">Up to date</span>
                      )}
                    </div>
                  ) : null}
                </div>
                {account.hasData && !account.updateAvailable && account.remoteVersion == null ? (
                  <div className="vantyr-account-menu-version__latest vantyr-account-menu-version__latest--muted">
                    GitHub latest: not reported
                  </div>
                ) : null}
              </div>

              <div className="vantyr-top-nav__account-menu-items">
                {menuItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={clsx("vantyr-top-nav__account-menu-item", item.danger && "is-danger")}
                      role="menuitem"
                      onClick={() => runMenuAction(item.id)}
                    >
                      <Icon size={15} aria-hidden="true" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
