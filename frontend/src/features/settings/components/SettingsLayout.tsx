import type { ComponentType, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Label } from "@vantyr/ui/components/label";
import { HelpTip } from "@/components/common/HelpTip";
import { cn } from "@/lib/utils";

/**
 * Arcane's settings design, in React: a settings area (section nav on the left, content on the right),
 * a titled section whose rows live in one outlined card, and rows with the label and description on
 * the left and the control on the right. Hover states are flat; there are no chips or glows.
 */

export interface SettingsNavItem {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

import { NAV_ITEM } from "./settingsNav";


/** The class names for the tab list when it is used as the section nav. */
export const SETTINGS_TAB_LIST_CLASS =
  "group-data-horizontal/tabs:h-auto h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0 lg:sticky lg:top-4 lg:w-56 lg:shrink-0 lg:flex-col lg:self-start lg:overflow-visible";

/** The class names for the tabs root so the nav sits left of the content on wide screens. */
export const SETTINGS_TABS_ROOT_CLASS = "gap-6 lg:data-horizontal:flex-row lg:gap-10";

/** Wide screens: nav left, content right. Narrow: nav on top, scrolling sideways. */
export function SettingsArea({
  nav,
  children,
  className,
}: {
  nav: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-6 lg:flex-row lg:gap-10", className)}>
      <div className="lg:sticky lg:top-4 lg:w-56 lg:shrink-0 lg:self-start">{nav}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Section nav built from links; the current page carries `aria-current`. */
export function SettingsNavLinks({
  items,
  label,
  isActive,
  hrefFor,
}: {
  items: readonly (SettingsNavItem & { to: string })[];
  label: string;
  isActive?: (item: SettingsNavItem & { to: string }, pathname: string) => boolean;
  hrefFor?: (item: SettingsNavItem & { to: string }) => string;
}) {
  const { pathname } = useLocation();
  const active =
    [...items]
      .reverse()
      .find((item) =>
        isActive ? isActive(item, pathname) : pathname === item.to || pathname.startsWith(`${item.to}/`),
      )?.id ?? items[0]?.id;
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto [scrollbar-width:none] lg:flex-col lg:overflow-visible [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const current = item.id === active;
        return (
          <Link
            key={item.id}
            to={hrefFor ? hrefFor(item) : item.to}
            aria-current={current ? "page" : undefined}
            className={cn(
              NAV_ITEM,
              "w-auto lg:w-full",
              current && "bg-muted/60 text-foreground [&_svg]:text-primary",
            )}
          >
            {Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Title, description and actions at the top of a settings page (Arcane's settings-page-layout). */
export function SettingsPageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * A section: title and description above, then the rows in one outlined card divided by hairlines.
 * `variant="plain"` leaves the body unframed for content that draws its own cards.
 */
export function SettingsSection({
  title,
  description,
  icon,
  help,
  action,
  children,
  className,
  bodyClassName,
  variant = "list",
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** A glyph shown before the title; pass the icon element. */
  icon?: ReactNode;
  /** Longer explanation shown on demand next to the title. */
  help?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  variant?: "list" | "plain";
  id?: string;
}) {
  return (
    <section id={id} className={cn("flex flex-col gap-3", className)}>
      {title || action ? (
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            {title ? (
              <h3 className="flex items-center gap-2 text-base font-semibold">
                {icon ? (
                  <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">
                    {icon}
                  </span>
                ) : null}
                {title}
                {help ? <HelpTip>{help}</HelpTip> : null}
              </h3>
            ) : null}
            {description ? (
              <p className="text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {variant === "list" ? (
        <div
          className={cn(
            "divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70 bg-card/10",
            bodyClassName,
          )}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/** Padding for free-form content inside a section card. */
export function SettingsCardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-6 px-5 py-4", className)}>{children}</div>;
}

/**
 * One setting: label and description on the left, the control on the right. `layout="switch"` keeps
 * the control on the same line at every width; the default stacks on narrow screens.
 */
export function SettingsRow({
  label,
  description,
  help,
  htmlFor,
  error,
  layout = "default",
  children,
  className,
  controlClassName,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** Longer explanation shown on demand. */
  help?: ReactNode;
  htmlFor?: string;
  error?: ReactNode;
  layout?: "default" | "switch";
  children?: ReactNode;
  className?: string;
  controlClassName?: string;
}) {
  const helpLabel = typeof label === "string" ? `About ${label}` : undefined;
  return (
    <div className={cn("px-5 py-4", className)}>
      <div
        className={cn(
          "grid gap-x-8 gap-y-3",
          layout === "switch"
            ? "grid-cols-[minmax(0,1fr)_auto] items-center"
            : "md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center",
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {htmlFor ? (
              <Label htmlFor={htmlFor} className="text-sm leading-snug font-semibold">
                {label}
              </Label>
            ) : (
              <div className="text-sm leading-snug font-semibold">{label}</div>
            )}
            {help ? <HelpTip label={helpLabel}>{help}</HelpTip> : null}
          </div>
          {description ? (
            <p className="mt-0.5 max-w-prose text-[0.8125rem] leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
          {layout === "switch" && error ? (
            <p role="alert" className="mt-1.5 text-xs font-medium text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {children !== undefined ? (
          <div
            className={cn(
              "min-w-0",
              layout === "switch" ? "flex justify-end" : "md:flex md:justify-end",
              controlClassName,
            )}
          >
            {children}
          </div>
        ) : null}
      </div>
      {layout !== "switch" && error ? (
        <p role="alert" className="mt-1.5 text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A stacked label/input pair with Arcane's field spacing, for forms that are not a row list. */
export function SettingsField({
  label,
  description,
  htmlFor,
  error,
  helpText,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  error?: ReactNode;
  helpText?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2.5", className)}>
      <div>
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
      {helpText ? <p className="text-xs text-muted-foreground">{helpText}</p> : null}
    </div>
  );
}
