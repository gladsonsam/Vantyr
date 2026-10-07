import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Boxes, ChevronsUpDown, PanelLeftClose, History, LogOut, MonitorSmartphone, ScrollText, Search, Settings2, ShieldCheck, UserCog, Users, X, type LucideIcon } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { Kbd, KbdGroup } from "@vantyr/ui/components/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@vantyr/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@vantyr/ui/components/tooltip";
import { cn } from "@/lib/utils";
import { VI } from "@/components/common/Icons";
import { DashboardUserAvatar } from "@/features/users/DashboardUserAvatar";
import type { NotificationItem } from "@/app/providers/useNotificationStore";
import type { Agent, DashboardNavUser } from "@/api/types";
import { CommandMenu, type CommandPage } from "./CommandMenu";

const COLLAPSE_KEY = "sidebar-collapsed";

interface AppShellProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  currentUser?: DashboardNavUser | null;
  onLogout: () => void;
  onShowPreferences: () => void;
  onOpenUsers?: () => void;
  onOpenActivityLog?: () => void;
  onOpenNotifications?: () => void;
  notifications: NotificationItem[];
  onDismissNotification: (id: string) => void;
  /** Devices offered by the ⌘K palette and counted on the nav item. */
  agents?: Agent[];
  onSelectAgent?: (agentId: string) => void;
  /**
   * Hide the breadcrumb bar and the page title block (the agent detail page
   * renders its own header). Sidebar, notifications and children stay.
   */
  hideTopBar?: boolean;
}

const NOTIFICATION_DOT: Record<string, string> = {
  success: "bg-success",
  error: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
};

interface NavSection {
  label: string;
  items: { label: string; path: string; icon: LucideIcon; badge?: string }[];
}

const PageActionsContext = createContext<HTMLElement | null>(null);

/**
 * Renders its children into the page header's action area (right of the
 * title), so pages that own the state behind a button — Save, Create — can
 * still place it in the shared header.
 */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionsContext);
  return slot ? createPortal(children, slot) : null;
}

const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** ⌘K launcher; shrinks to an icon button when the sidebar is collapsed. */
function SidebarSearch({ onOpen }: { onOpen: () => void }) {
  const { state, isMobile } = useSidebar();
  if (state === "collapsed" && !isMobile) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="Search" onClick={onOpen} aria-label="Search devices and pages">
            <Search />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search devices and pages"
      className="flex h-9 w-full items-center gap-2.5 rounded-md bg-sidebar-accent/60 px-2.5 text-sm text-sidebar-foreground/55 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&_svg]:size-4"
    >
      <Search />
      <span>Search…</span>
      {!isMobile && (
        <KbdGroup className="ml-auto">
          <Kbd>{MOD_KEY}</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      )}
    </button>
  );
}

/**
 * Logo row. Expanded: logo links home and a collapse button sits at the right.
 * Collapsed to icons: the logo itself becomes the expand control.
 */
function SidebarBrand() {
  const { state, isMobile, toggleSidebar } = useSidebar();
  const logo = <VI.logo aria-hidden="true" className="size-5.5 text-primary" />;
  if (state === "collapsed" && !isMobile) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            />
          }
        >
          {logo}
        </TooltipTrigger>
        <TooltipContent side="right">Expand sidebar</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <div className="flex h-10 items-center gap-2.5 pl-2">
      <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
        {logo}
        <span className="truncate font-heading text-[15px] font-semibold tracking-tight">Vantyr</span>
      </Link>
      {!isMobile && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleSidebar}
                aria-label="Collapse sidebar"
                className="ml-auto text-sidebar-foreground/60 hover:text-sidebar-foreground"
              />
            }
          >
            <PanelLeftClose />
          </TooltipTrigger>
          <TooltipContent side="right">
            Collapse <span className="opacity-60">· Ctrl B</span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function AppShell({
  title,
  description,
  children,
  currentUser = null,
  onLogout,
  onShowPreferences,
  onOpenUsers,
  onOpenActivityLog,
  onOpenNotifications,
  notifications,
  onDismissNotification,
  agents = [],
  onSelectAgent,
  hideTopBar = false,
}: AppShellProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [commandOpen, setCommandOpen] = useState(false);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) !== "true";
    } catch {
      return true;
    }
  });
  const changeOpen = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, String(!next));
    } catch {
      // Storage may be blocked; the preference just won't persist.
    }
  };

  const isAdmin = currentUser?.role === "admin";
  const onlineCount = agents.filter((agent) => agent.online).length;
  // Add pages here; empty sections are dropped, so role-gated items just disappear.
  const sections: NavSection[] = [
    {
      label: "Fleet",
      items: [
        { label: "Agents", path: "/", icon: MonitorSmartphone, badge: agents.length ? `${onlineCount}/${agents.length}` : undefined },
        ...(isAdmin ? [{ label: "Groups", path: "/groups", icon: Boxes }] : []),
        ...(currentUser && currentUser.role !== "viewer" ? [{ label: "Recall", path: "/recall", icon: History }] : []),
      ],
    },
    {
      label: "Policy",
      items: [
        ...(onOpenNotifications ? [{ label: "Rules", path: "/rules", icon: ShieldCheck }] : []),
        ...(onOpenActivityLog ? [{ label: "Audit log", path: "/logs", icon: ScrollText }] : []),
      ],
    },
    {
      label: "Admin",
      items: [
        ...(isAdmin && onOpenUsers ? [{ label: "Users", path: "/users", icon: Users }] : []),
        { label: "Settings", path: "/settings", icon: Settings2 },
      ],
    },
  ].filter((section) => section.items.length > 0);
  const isActive = (path: string) => (path === "/" ? pathname === "/" : pathname.startsWith(path));
  const commandPages: CommandPage[] = sections.flatMap((section) =>
    section.items.map((item) => ({ label: item.label, icon: item.icon, onSelect: () => navigate(item.path) })),
  );
  commandPages.push({ label: "Account settings", icon: UserCog, onSelect: onShowPreferences });
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);

  const userLabel = currentUser ? currentUser.display_name?.trim() || currentUser.username : "Account";

  return (
    <TooltipProvider delay={300}>
      <SidebarProvider open={open} onOpenChange={changeOpen} className="h-svh min-h-0 overflow-hidden font-sans antialiased">
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader className="gap-3 p-3 group-data-[collapsible=icon]:px-2">
            <SidebarBrand />
            <SidebarSearch onOpen={() => setCommandOpen(true)} />
          </SidebarHeader>

          <SidebarContent className="gap-2 px-1 group-data-[collapsible=icon]:px-0">
            {sections.map((section) => (
              <SidebarGroup key={section.label}>
                <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {section.items.map((item) => (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton isActive={isActive(item.path)} tooltip={item.label} render={<Link to={item.path} />}>
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                        {item.badge && (
                          <SidebarMenuBadge className="font-mono text-[11px] text-sidebar-foreground/55 tabular-nums">{item.badge}</SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>

          <SidebarFooter className="p-3 group-data-[collapsible=icon]:p-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<SidebarMenuButton size="lg" aria-label="Account options" className="data-popup-open:bg-sidebar-accent" />}
                  >
                    <DashboardUserAvatar
                      username={currentUser?.username ?? "account"}
                      displayName={currentUser?.display_name}
                      displayIcon={currentUser?.display_icon}
                      size={32}
                    />
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{userLabel}</span>
                      <span className="truncate text-xs text-sidebar-foreground/60 capitalize">{currentUser?.role ?? "user"}</span>
                    </div>
                    <ChevronsUpDown className="ml-auto" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>
                        Signed in as <span className="text-foreground">{currentUser?.username ?? "unknown"}</span>
                      </DropdownMenuLabel>
                      <DropdownMenuItem onClick={onShowPreferences}>
                        <UserCog /> Account settings
                      </DropdownMenuItem>
                      {isAdmin && onOpenUsers && (
                        <DropdownMenuItem onClick={onOpenUsers}>
                          <Users /> User accounts
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onLogout}>
                      <LogOut /> Log out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset className="min-w-0 overflow-hidden">
          {!hideTopBar && (
            // Phones only: desktop navigates and searches from the sidebar.
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-3 md:hidden">
              <SidebarTrigger />
              <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 font-heading font-semibold tracking-tight">
                <VI.logo aria-hidden="true" className="size-5 text-primary" />
                Vantyr
              </Link>
              <Button variant="ghost" size="icon-sm" onClick={() => setCommandOpen(true)} aria-label="Search devices and pages">
                <Search />
              </Button>
            </header>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className={cn("mx-auto flex w-full max-w-[1680px] flex-col gap-8", !hideTopBar && "px-5 py-6 md:px-10 md:py-10")}>
              {notifications.length > 0 && (
                <div className="flex flex-col gap-2">
                  {notifications.map((n) => (
                    <div key={n.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-card px-3 py-2 text-sm">
                      <span className={cn("size-2 shrink-0 rounded-full", NOTIFICATION_DOT[n.type ?? "info"] ?? "bg-info")} />
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">{n.header}</span>
                        {n.content && <span className="text-muted-foreground"> · {n.content}</span>}
                      </div>
                      {n.action}
                      {n.dismissible !== false && (
                        <Button variant="ghost" size="xs" onClick={() => onDismissNotification(n.id)}>
                          {n.dismissLabel || (
                            <>
                              <X /> Dismiss
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!hideTopBar && (
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <h1 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
                    {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
                  </div>
                  <div ref={setActionsSlot} className="flex shrink-0 flex-wrap items-center gap-2 empty:hidden" />
                </div>
              )}
              <PageActionsContext.Provider value={actionsSlot}>{children}</PageActionsContext.Provider>
            </div>
          </div>
        </SidebarInset>

        <CommandMenu
          open={commandOpen}
          onOpenChange={setCommandOpen}
          pages={commandPages}
          agents={agents}
          onSelectAgent={onSelectAgent}
        />
      </SidebarProvider>
    </TooltipProvider>
  );
}

/** Centered loading state for route-level loading. */
export function LoadContent({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[300px] w-full flex-col items-center justify-center gap-4 text-muted-foreground">
      <span className="size-8 animate-spin rounded-full border-[3px] border-muted border-t-primary" aria-hidden="true" />
      <div className="text-[13px] font-medium tracking-wide">{label}</div>
    </div>
  );
}
