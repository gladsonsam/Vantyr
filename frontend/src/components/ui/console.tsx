import clsx from "clsx";
import { Search } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type ConsoleStatus = "connected" | "ok" | "active" | "afk" | "offline" | "blocked" | "danger";

interface StatusDotProps {
  status: ConsoleStatus;
  pulse?: boolean;
  className?: string;
}

export function StatusDot({ status, pulse = false, className }: StatusDotProps) {
  return (
    <span
      className={clsx("sx-status-dot", `sx-status-dot--${status}`, pulse && "sx-status-dot--pulse", className)}
      aria-hidden="true"
    />
  );
}

interface StatusPillProps {
  status: ConsoleStatus;
  children: ReactNode;
  pulse?: boolean;
  className?: string;
}

export function StatusPill({ status, children, pulse = false, className }: StatusPillProps) {
  return (
    <span className={clsx("sx-status-pill", `sx-status-pill--${status}`, className)}>
      <StatusDot status={status} pulse={pulse} />
      {children}
    </span>
  );
}

export type OsKind = "windows" | "macos" | "linux" | "docker" | "unknown";

const osLabels: Record<OsKind, string> = {
  windows: "WIN",
  macos: "MAC",
  linux: "LNX",
  docker: "DKR",
  unknown: "OS",
};

interface OsBadgeProps {
  os: OsKind;
  label?: string;
  className?: string;
}

export function OsBadge({ os, label, className }: OsBadgeProps) {
  const text = label ?? osLabels[os];
  return (
    <span className={clsx("sx-os-badge", `sx-os-badge--${os}`, className)} title={text} aria-label={`${text} device`}>
      {text}
    </span>
  );
}

type ConsoleButtonVariant = "default" | "primary" | "ghost" | "danger";

interface ConsoleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon;
  variant?: ConsoleButtonVariant;
}

export function ConsoleButton({
  icon: Icon,
  variant = "default",
  className,
  children,
  type = "button",
  ...props
}: ConsoleButtonProps) {
  return (
    <button
      type={type}
      className={clsx("sx-console-button", `sx-console-button--${variant}`, className)}
      {...props}
    >
      {Icon ? <Icon className="sx-console-button__icon" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  accent?: boolean;
}

export function IconButton({ icon: Icon, label, accent = false, className, type = "button", ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      className={clsx("sx-icon-button", accent && "sx-icon-button--accent", className)}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

export interface SegmentedFilterOption<TValue extends string> {
  value: TValue;
  label: string;
  count?: number;
}

interface SegmentedFilterProps<TValue extends string> {
  value: TValue;
  options: SegmentedFilterOption<TValue>[];
  onChange: (value: TValue) => void;
  ariaLabel: string;
  className?: string;
}

export function SegmentedFilter<TValue extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: SegmentedFilterProps<TValue>) {
  return (
    <div className={clsx("sx-segmented-filter", className)} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="sx-segmented-filter__item"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.count != null ? <span className="sx-segmented-filter__count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  containerClassName?: string;
}

export function SearchField({ label, containerClassName, className, ...props }: SearchFieldProps) {
  return (
    <label className={clsx("sx-search-field", containerClassName)}>
      <Search aria-hidden="true" />
      <span className="awsui-util-hide">{label}</span>
      <input type="search" className={clsx("sx-search-field__input", className)} {...props} />
    </label>
  );
}

export interface MetricItem {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
}

interface MetricStripProps {
  items: MetricItem[];
  className?: string;
}

export function MetricStrip({ items, className }: MetricStripProps) {
  return (
    <div className={clsx("sx-metric-strip", className)}>
      {items.map((item) => (
        <div className="sx-metric" key={item.label}>
          <p className="sx-metric__label">{item.label}</p>
          <div className="sx-metric__value">{item.value}</div>
          {item.meta ? <div className="sx-metric__meta">{item.meta}</div> : null}
        </div>
      ))}
    </div>
  );
}
