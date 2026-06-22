import React, { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  ChevronDown,
  AlertCircle,
  X,
  Plus,
  Trash,
  ExternalLink,
  RotateCw,
  ZoomIn,
  ChevronRight,
} from "lucide-react";

/* ==========================================
   Original Console Primitives (from 626c761)
   ========================================== */

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
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  docker: "Docker",
  unknown: "Other OS",
};

interface OsBadgeProps {
  os: OsKind;
  label?: string;
  className?: string;
  size?: number;
  style?: React.CSSProperties;
}

export function OsBadge({ os, label, className, size, style }: OsBadgeProps) {
  const text = label ?? osLabels[os];
  const iconSize = size ? Math.max(12, Math.round(size * 0.5)) : 14;

  // Modern duotone SVG icons instead of low-fi text tags
  const renderSvg = () => {
    switch (os) {
      case "windows":
        return (
          <svg viewBox="0 0 24 24" fill="currentColor" width={iconSize} height={iconSize} style={{ display: 'block' }}>
            <path d="M0 3.449L9.75 2.1v9.45H0V3.449zM0 12.45h9.75v9.45L0 20.551v-8.1zM10.95 1.936L24 0v11.55H10.95V1.936zM10.95 12.45H24v11.55l-13.05-1.936v-9.614z" />
          </svg>
        );
      case "macos":
        return (
          <svg viewBox="0 0 24 24" fill="currentColor" width={iconSize} height={iconSize} style={{ display: 'block' }}>
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 4.17c.66-.81 1.11-1.93.99-3.06-.96.04-2.13.64-2.82 1.45-.6.7-1.13 1.84-.99 2.94.1.08 2.16-.52 2.82-1.33z" />
          </svg>
        );
      case "linux":
        return (
          <svg viewBox="0 0 24 24" fill="currentColor" width={iconSize} height={iconSize} style={{ display: 'block' }}>
            <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z" />
          </svg>
        );
      case "docker":
        return (
          <svg viewBox="0 0 24 24" fill="currentColor" width={iconSize} height={iconSize} style={{ display: 'block' }}>
            <path d="M13.983 11.078h2.119c.102 0 .186-.083.186-.185V8.902c0-.102-.084-.186-.186-.186h-2.119c-.103 0-.186.084-.186.186v1.99c0 .103.083.186.186.186zm-2.95 0h2.118c.103 0 .187-.083.187-.185V8.902c0-.102-.084-.186-.187-.186h-2.118c-.103 0-.186.084-.186.186v1.99c0 .103.083.186.186.186zm-2.935 0h2.119c.103 0 .186-.083.186-.185V8.902c0-.102-.083-.186-.186-.186H8.098c-.103 0-.186.084-.186.186v1.99c0 .103.083.186.186.186zm-2.934 0h2.119c.103 0 .186-.083.186-.185V8.902c0-.102-.083-.186-.186-.186H5.164c-.102 0-.185.084-.185.186v1.99c0 .103.083.186.185.186zm2.934-2.99h2.119c.103 0 .186-.083.186-.185V5.912c0-.102-.083-.186-.186-.186H8.098c-.103 0-.186.084-.186.186v1.99c-.001.103.082.186.186.186zm2.935 0h2.118c.103 0 .187-.083.187-.185V5.912c0-.102-.084-.186-.187-.186h-2.118c-.103 0-.186.084-.186.186v1.99c0 .103.083.186.186.186zm2.95 0h2.119c.102 0 .186-.083.186-.185V5.912c0-.102-.084-.186-.186-.186h-2.119c-.103 0-.186.084-.186.186v1.99c0 .103.083.186.186.186zm-5.885-2.99h2.118c.103 0 .186-.083.186-.186V2.936c0-.102-.083-.186-.186-.186h-2.118c-.103 0-.186.084-.186.186v1.99c0 .103.083.186.186.186zm11.89 5.98h2.119c.103 0 .186-.083.186-.185V8.902c0-.102-.083-.186-.186-.186h-2.119c-.103 0-.186.084-.186.186v1.99c0 .103.083.186.186.186zm-18.72 2.95c.53 2.477 2.193 4.545 4.673 5.485C6.46 19.82 9.07 20 12.02 20c7.65 0 11.51-4.73 11.87-10.1h-21.71c.05 1.15.19 2.11.54 3.03z" />
          </svg>
        );
      default:
        const defIconSize = size ? Math.max(12, Math.round(size * 0.46)) : 13;
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width={defIconSize} height={defIconSize} style={{ display: 'block' }}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        );
    }
  };

  const sizeStyle = size ? {
    width: size,
    height: size,
    borderRadius: size * 0.32,
  } : {};

  return (
    <span
      className={clsx("sx-os-badge", `sx-os-badge--${os}`, className)}
      title={text}
      aria-label={`${text} device`}
      style={{ ...sizeStyle, ...style }}
    >
      {renderSvg()}
    </span>
  );
}

type ConsoleButtonVariant = "default" | "primary" | "ghost" | "danger";

interface ConsoleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: any;
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

// 1. Box
interface BoxProps {
  children?: React.ReactNode;
  /** Semantic HTML tag override — "strong", "span", "code", "h3", etc. render as that element. */
  variant?: string;
  color?: string;
  textAlign?: "left" | "center" | "right";
  padding?: any;
  fontSize?: string;
  float?: string;
  margin?: any;
  display?: string;
  fontWeight?: string | number;
  tagOverride?: string;
  className?: string;
  onClick?: (event: any) => void;
  nativeAttributes?: any;
}

const BOX_SEMANTIC_TAGS = new Set(["strong","em","b","i","span","code","mark","small","sub","sup","p","h1","h2","h3","h4","h5","h6","section","article","aside","label"]);

export function Box({ children, color, textAlign, padding, fontSize, float, margin, display, fontWeight, tagOverride, variant, className, onClick, nativeAttributes }: BoxProps) {
  let pStyle: string | undefined = undefined;
  if (typeof padding === "string") {
    pStyle = padding === "l" ? "24px" : padding === "m" ? "16px" : padding === "s" ? "8px" : padding;
  } else if (padding && typeof padding === "object") {
    const resolvePaddingValue = (val: string) => val === "l" ? "24px" : val === "m" ? "16px" : val === "s" ? "8px" : val;
    const t = padding.top ? resolvePaddingValue(padding.top) : "0";
    const r = padding.right ? resolvePaddingValue(padding.right) : "0";
    const b = padding.bottom ? resolvePaddingValue(padding.bottom) : "0";
    const l = padding.left ? resolvePaddingValue(padding.left) : "0";
    pStyle = `${t} ${r} ${b} ${l}`;
  }

  const style: React.CSSProperties = {
    textAlign: textAlign || "left",
    padding: pStyle,
    color: color === "text-body-secondary" ? "var(--text-3)" : undefined,
    fontSize,
    float: float as any,
    margin: typeof margin === 'string' ? margin : (margin ? `${margin.top || 0} ${margin.right || 0} ${margin.bottom || 0} ${margin.left || 0}` : undefined),
    display,
    fontWeight,
    ...(nativeAttributes?.style || {}),
  };
  
  const Tag = (tagOverride || (variant && BOX_SEMANTIC_TAGS.has(variant) ? variant : undefined) || "div") as any;
  
  return (
    <Tag className={className} style={style} onClick={onClick}>
      {children}
    </Tag>
  );
}

// 2. Spinner
interface SpinnerProps {
  size?: "normal" | "large" | string;
}

export function Spinner({ size }: SpinnerProps) {
  const s = size === "large" ? "32px" : "18px";
  return (
    <div
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: s,
        height: s,
        border: "2px solid var(--border-3)",
        borderTopColor: "var(--accent)",
        borderRadius: "50%",
        animation: "vtl-spin 0.8s linear infinite",
      }}
    />
  );
}

// 3. Button
interface ButtonProps {
  children?: React.ReactNode;
  onClick?: (event: any) => void;
  disabled?: boolean;
  variant?: string;
  loading?: boolean;
  href?: string;
  target?: string;
  rel?: string;
  ariaLabel?: string;
  iconName?: string;
  className?: string;
  type?: "button" | "submit" | "reset";
}

const iconMap: Record<string, any> = {
  "add-plus": Plus,
  remove: Trash,
  external: ExternalLink,
  refresh: RotateCw,
  "zoom-to-fit": ZoomIn,
  "angle-right": ChevronRight,
  close: X,
};

export function Button({
  children,
  onClick,
  disabled,
  variant,
  loading,
  href,
  target,
  rel,
  ariaLabel,
  iconName,
  className: customClassName,
  type = "button",
}: ButtonProps) {
  const Icon = iconName ? iconMap[iconName] : null;
  const className = clsx("btn", variant, customClassName);
  
  if (href) {
    return (
      <a
        href={href}
        target={target}
        rel={rel}
        className={className}
        aria-label={ariaLabel}
        style={{ opacity: disabled ? 0.45 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
      >
        {loading && <Spinner />}
        {Icon && <Icon size={14} />}
        {children}
      </a>
    );
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={className}
      aria-label={ariaLabel}
      style={{ opacity: disabled ? 0.45 : 1, cursor: (disabled || loading) ? "not-allowed" : "pointer" }}
    >
      {loading && <Spinner />}
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
}

// 4. Input
interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "onKeyDown"> {
  value?: string;
  onChange?: (event: { detail: { value: string } }) => void;
  onKeyDown?: (event: { detail: { key: string } }) => void;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ value, onChange, onKeyDown, disabled, style: customStyle, ...props }, ref) => {
  return (
    <div className="field" style={{ width: "100%", opacity: disabled ? 0.6 : 1 }}>
      <input
        ref={ref}
        type={props.type || "text"}
        value={value ?? ""}
        onChange={(e) => onChange?.({ detail: { value: e.target.value } })}
        onKeyDown={(e) => onKeyDown?.({ detail: { key: e.key } })}
        disabled={disabled}
        {...props}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          outline: "none",
          color: "var(--text)",
          ...customStyle,
        }}
      />
    </div>
  );
});

// 5. Select
export interface SelectProps {
  selectedOption?: any;
  onChange?: (event: { detail: { selectedOption: any } }) => void;
  options: any[];
  placeholder?: string;
  disabled?: boolean;
  filteringType?: string;
  empty?: React.ReactNode;
  loadingText?: string;
  statusType?: "loading" | "finished" | string;
}

export namespace SelectProps {
  export interface Option {
    value: string;
    label: string;
    description?: string;
    labelTag?: string;
  }
  export type Options = Option[];
}

export function Select({ selectedOption, onChange, options, placeholder, disabled, empty }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const clickAway = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", clickAway);
    return () => document.removeEventListener("mousedown", clickAway);
  }, []);

  const currentLabel = selectedOption?.label || selectedOption?.value || placeholder || "Choose an option";

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", minWidth: "160px" }}>
      <button
        type="button"
        className="field"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentLabel}</span>
        <ChevronDown size={14} style={{ color: "var(--text-3)" }} />
      </button>

      {open && (
        <div
          className="scroller"
          style={{
            position: "absolute",
            top: "105%",
            left: 0,
            width: "100%",
            background: "var(--surface-2)",
            border: "1px solid var(--border-3)",
            borderRadius: "var(--r-sm)",
            zIndex: 1000,
            maxHeight: "240px",
            overflowY: "auto",
            boxShadow: "var(--shadow)",
          }}
        >
          {options.length === 0 ? (
            <div style={{ padding: "10px 12px", color: "var(--text-3)", fontSize: "12.5px" }}>{empty || "No options"}</div>
          ) : (
            options.map((opt: any) => {
              const sel = selectedOption?.value === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange?.({ detail: { selectedOption: opt } });
                    setOpen(false);
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: sel ? "var(--accent-soft)" : "transparent",
                    color: sel ? "var(--text)" : "var(--text-2)",
                    border: "none",
                    padding: "8px 12px",
                    cursor: "pointer",
                    fontSize: "13px",
                  }}
                  onMouseEnter={(e) => {
                    if (!sel) e.currentTarget.style.background = "var(--surface-3)";
                  }}
                  onMouseLeave={(e) => {
                    if (!sel) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {opt.label || opt.value}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// 6. Toggle
interface ToggleProps {
  checked?: boolean;
  onChange?: (event: { detail: { checked: boolean } }) => void;
  disabled?: boolean;
  children?: React.ReactNode;
  description?: React.ReactNode;
}

export function Toggle({ checked, onChange, disabled, children, description }: ToggleProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 10, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }}>
        <div
          style={{
            width: 38,
            height: 20,
            borderRadius: 99,
            background: checked ? "var(--accent)" : "var(--surface-3)",
            position: "relative",
            transition: "background 0.2s",
            border: "1px solid var(--border-2)",
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#fff",
              position: "absolute",
              top: 2,
              left: checked ? 20 : 2,
              transition: "left 0.2s",
            }}
          />
        </div>
        {children && <span style={{ fontSize: "13px", color: "var(--text)" }}>{children}</span>}
        <input
          type="checkbox"
          checked={!!checked}
          disabled={disabled}
          onChange={(e) => onChange?.({ detail: { checked: e.target.checked } })}
          style={{ display: "none" }}
        />
      </label>
      {description && <span style={{ fontSize: "11px", color: "var(--text-3)", marginLeft: 48 }}>{description}</span>}
    </div>
  );
}

// 7. Checkbox
interface CheckboxProps {
  checked?: boolean;
  onChange?: (event: { detail: { checked: boolean } }) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}

export function Checkbox({ checked, onChange, disabled, children }: CheckboxProps) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }}>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange?.({ detail: { checked: e.target.checked } })}
        style={{
          accentColor: "var(--accent)",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      />
      {children && <span style={{ fontSize: "13px", color: "var(--text)" }}>{children}</span>}
    </label>
  );
}

// 8. Textarea
interface TextareaProps {
  value?: string;
  onChange?: (event: { detail: { value: string } }) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}

export function Textarea({ value, onChange, placeholder, disabled, rows }: TextareaProps) {
  return (
    <div style={{ border: "1px solid var(--border-2)", background: "var(--bg-2)", borderRadius: "var(--r-sm)", padding: "8px 12px" }}>
      <textarea
        value={value ?? ""}
        onChange={(e) => onChange?.({ detail: { value: e.target.value } })}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows || 3}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontFamily: "var(--sans)",
          fontSize: "13.5px",
          resize: "vertical",
        }}
      />
    </div>
  );
}

// 9. Tabs
interface TabDefinition {
  id: string;
  label: React.ReactNode;
  content: React.ReactNode;
}

interface TabsProps {
  tabs: TabDefinition[];
  activeTabId?: string;
  onChange?: (event: { detail: { activeTabId: string } }) => void;
  variant?: string;
}

export function Tabs({ tabs, activeTabId, onChange }: TabsProps) {
  // Support both controlled (activeTabId + onChange) and uncontrolled use.
  // When no activeTabId is supplied, the component owns its own selection so
  // clicking a tab actually switches content (e.g. the per-agent Settings tab).
  const isControlled = activeTabId !== undefined;
  const [internalTabId, setInternalTabId] = React.useState<string | undefined>(undefined);
  const currentTab = (isControlled ? activeTabId : internalTabId) ?? tabs[0]?.id;
  const tabItem = tabs.find((t: any) => t.id === currentTab);

  const handleSelect = (id: string) => {
    if (!isControlled) setInternalTabId(id);
    onChange?.({ detail: { activeTabId: id } });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      <div style={{ overflowX: "auto", width: "100%", marginBottom: 16 }}>
        <div className="seg" style={{ whiteSpace: "nowrap" }}>
          {tabs.map((tab: any) => {
            const isSelected = tab.id === currentTab;
            return (
              <button
                key={tab.id}
                type="button"
                className={isSelected ? "on" : ""}
                onClick={() => handleSelect(tab.id)}
                style={{
                  background: isSelected ? "var(--surface-2)" : "transparent",
                  color: isSelected ? "var(--text)" : "var(--text-3)",
                  border: "none",
                  cursor: "pointer",
                  padding: "6px 12px",
                  borderRadius: "7px",
                  fontWeight: 600,
                  fontSize: "12.5px",
                  whiteSpace: "nowrap",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ width: "100%" }}>{tabItem?.content}</div>
    </div>
  );
}

// 10. Container
interface ContainerProps {
  children?: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export function Container({ children, header, footer }: ContainerProps) {
  return (
    <div
      style={{
        borderRadius: "var(--r-lg)",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        overflow: "hidden",
        boxShadow: "var(--shadow)",
        marginBottom: 20,
      }}
    >
      {header && (
        <div className="sx-container-header" style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          {header}
        </div>
      )}
      <div className="sx-container-body" style={{ padding: "20px" }}>{children}</div>
      {footer && (
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", background: "var(--bg-2)" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

// 11. Header
interface HeaderProps {
  children?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  variant?: "h1" | "h2" | "h3" | string;
  counter?: string | number;
}

export function Header({ children, description, actions, variant, counter }: HeaderProps) {
  const isH1 = variant === "h1";
  const size = isH1 ? "22px" : "16px";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
      <div style={{ minWidth: "160px", flex: 1 }}>
        <h2 style={{ margin: 0, fontSize: size, fontWeight: 800, letterSpacing: "-0.02em" }}>
          {children}
          {counter !== undefined && (
            <span className="sx-mono" style={{ marginLeft: 8, fontSize: "14px", color: "var(--text-3)" }}>
              {typeof counter === "number" || (typeof counter === "string" && !counter.startsWith("(") && !counter.endsWith(")")) ? `(${counter})` : counter}
            </span>
          )}
        </h2>
        {description && <div style={{ fontSize: "12px", color: "var(--text-3)", marginTop: 4 }}>{description}</div>}
      </div>
      {actions && <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}

// 12. FormField
interface FormFieldProps {
  children?: React.ReactNode;
  label?: React.ReactNode;
  description?: React.ReactNode;
  constraintText?: React.ReactNode;
  errorText?: React.ReactNode;
  stretch?: boolean;
}

export function FormField({ children, label, description, constraintText, errorText }: FormFieldProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, width: "100%" }}>
      {label && <label style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-2)" }}>{label}</label>}
      {description && <span style={{ fontSize: "11.5px", color: "var(--text-3)" }}>{description}</span>}
      <div style={{ width: "100%" }}>{children}</div>
      {constraintText && !errorText && <span style={{ fontSize: "11px", color: "var(--text-4)" }}>{constraintText}</span>}
      {errorText && <span style={{ fontSize: "11px", color: "var(--down)", fontWeight: 500 }}>{errorText}</span>}
    </div>
  );
}

// 13. SpaceBetween
interface SpaceBetweenProps {
  children?: React.ReactNode;
  size?: "xs" | "s" | "m" | "l" | "xl" | string;
  direction?: "horizontal" | "vertical" | string;
  alignItems?: string;
  className?: string;
}

export function SpaceBetween({ children, size, direction, alignItems, className }: SpaceBetweenProps) {
  const gap = size === "l" ? "20px" : size === "m" ? "12px" : "8px";
  const dir = direction === "horizontal" ? "row" : "column";
  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: dir,
        gap,
        alignItems: alignItems || (direction === "horizontal" ? "center" : "stretch"),
        width: direction === "horizontal" ? undefined : "100%",
      }}
    >
      {children}
    </div>
  );
}

// 14. ColumnLayout
interface ColumnLayoutProps {
  children?: React.ReactNode;
  columns?: number;
  variant?: string;
}

export function ColumnLayout({ children, columns }: ColumnLayoutProps) {
  return (
    <div
      className="sx-column-layout"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns || 3}, minmax(0, 1fr))`,
        gap: "20px",
        width: "100%",
      }}
    >
      {children}
    </div>
  );
}

// 15. Grid
interface GridProps {
  children?: React.ReactNode;
  gridDefinition?: { colspan?: number }[];
}

export function Grid({ children, gridDefinition }: GridProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gap: "18px",
        width: "100%",
      }}
    >
      {React.Children.map(children, (child, idx) => {
        const span = gridDefinition?.[idx]?.colspan || 12;
        return <div style={{ gridColumn: `span ${span}` }}>{child}</div>;
      })}
    </div>
  );
}

// 16. KeyValuePairs
interface KeyValuePairItem {
  label: React.ReactNode;
  value: React.ReactNode;
}

interface KeyValuePairsProps {
  items: KeyValuePairItem[];
  columns?: number;
}

export function KeyValuePairs({ items, columns }: KeyValuePairsProps) {
  const cols = columns || 3;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: "16px",
        marginBottom: 16,
      }}
    >
      {items.map((item: any, i: number) => (
        <div key={i}>
          <div className="eyebrow" style={{ fontSize: "9.5px", marginBottom: 4 }}>{item.label}</div>
          <div className="mono" style={{ fontSize: "13px", color: "var(--text-2)" }}>{item.value || "—"}</div>
        </div>
      ))}
    </div>
  );
}

// 17. Alert
interface AlertProps {
  children?: React.ReactNode;
  type?: "info" | "success" | "warning" | "error" | string;
  dismissible?: boolean;
  onDismiss?: () => void;
  header?: React.ReactNode;
  statusIconAriaLabel?: string;
}

export function Alert({ children, type, dismissible, onDismiss, header }: AlertProps) {
  const color = type === "error" ? "var(--down)" : type === "success" ? "var(--ok)" : type === "warning" ? "var(--afk)" : "var(--active)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 16px",
        borderRadius: "var(--r)",
        border: `1px solid ${color}40`,
        background: `${color}0b`,
        color: "var(--text)",
        marginBottom: 14,
      }}
    >
      <AlertCircle size={16} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1 }}>
        {header && <div style={{ fontWeight: 700, fontSize: "13px", marginBottom: 2 }}>{header}</div>}
        <div style={{ fontSize: "12.5px", color: "var(--text-2)" }}>{children}</div>
      </div>
      {dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", padding: 0 }}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}

// 18. Table
export interface TableColumnDefinition<T = any> {
  id: string;
  header: React.ReactNode;
  cell: (item: T) => React.ReactNode;
  width?: number | string;
  sortingField?: string;
  minWidth?: string | number;
}

interface TableProps<T = any> {
  items: readonly T[];
  columnDefinitions: TableColumnDefinition<T>[];
  loading?: boolean;
  loadingText?: string;
  empty?: React.ReactNode;
  variant?: string;
  selectionType?: "multi" | "none" | string;
  selectedItems?: readonly T[];
  onSelectionChange?: (event: { detail: { selectedItems: T[] } }) => void;
  stickyHeader?: boolean;
  trackBy?: string | ((item: T) => string | number);
  wrapLines?: boolean;
  header?: React.ReactNode;
  filter?: React.ReactNode;
  pagination?: React.ReactNode;
  sortingColumn?: any;
  sortingDescending?: boolean;
  onSortingChange?: (event: { detail: { sortingColumn: any; isDescending?: boolean } }) => void;
  isDescending?: boolean;
  onRowClick?: (event: { detail: { item: T } }) => void;
}

export namespace TableProps {
  export type ColumnDefinition<T> = TableColumnDefinition<T>;
  export interface SortingState<T> {
    sortingColumn: TableColumnDefinition<T>;
    isDescending?: boolean;
  }
}

export function Table({
  items,
  columnDefinitions,
  loading,
  loadingText,
  empty,
  variant,
  selectionType,
  selectedItems,
  onSelectionChange,
  trackBy,
  header,
  filter,
  pagination,
  onRowClick,
  minWidth,
}: TableProps & { minWidth?: number }) {
  // Identity for selection comparison. Falls back to `id` only when no trackBy is
  // given — without this, items lacking an `id` field all compare equal (undefined),
  // so selecting one row would mark every row selected.
  const keyOf = (item: any): string | number | undefined => {
    if (typeof trackBy === "function") return trackBy(item);
    if (typeof trackBy === "string") return item?.[trackBy];
    return item?.id;
  };
  const isItemSelected = (item: any) =>
    !!selectedItems?.some((si: any) => keyOf(si) === keyOf(item));
  // Floor the table width to the sum of its column widths so narrow viewports
  // scroll horizontally (via the overflow-x wrapper) instead of squeezing
  // columns until cell text wraps one character per line.
  const FALLBACK_COL_WIDTH = 160;
  const colPx = (w?: number | string): number => {
    if (typeof w === "number") return w;
    if (typeof w === "string") {
      const n = parseInt(w, 10);
      return Number.isFinite(n) ? n : FALLBACK_COL_WIDTH;
    }
    return FALLBACK_COL_WIDTH;
  };
  const computedMinWidth =
    minWidth ??
    (columnDefinitions.reduce((sum, c) => sum + colPx(c.width), 0) +
      (selectionType === "multi" ? 44 : 0));
  return (
    <div
      style={{
        borderRadius: variant === "embedded" ? "0" : "var(--r-lg)",
        border: variant === "embedded" ? "none" : "1px solid var(--border)",
        background: variant === "embedded" ? "transparent" : "var(--surface)",
        overflow: "hidden",
        boxShadow: variant === "embedded" ? "none" : "var(--shadow)",
        width: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {header && (
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          {header}
        </div>
      )}
      {filter && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-2)", background: "var(--bg-2)", display: "flex", gap: 12 }}>
          {filter}
        </div>
      )}
      {loading && items.length > 0 && (
        <div
          className="sx-table-loader"
          style={{
            height: "2.5px",
            width: "100%",
            position: "absolute",
            top: 0,
            left: 0,
            zIndex: 10,
          }}
        />
      )}
      <div style={{ overflowX: "auto", width: "100%" }}>
        <table style={{ width: "100%", minWidth: computedMinWidth, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-2)" }}>
              {selectionType === "multi" && (
                <th style={{ width: 40, padding: "10px 16px", borderBottom: "1px solid var(--border-2)" }}>
                  <input
                    type="checkbox"
                    checked={items.length > 0 && items.every((it) => isItemSelected(it))}
                    onChange={(e) => {
                      if (e.target.checked) {
                        onSelectionChange?.({ detail: { selectedItems: [...items] } });
                      } else {
                        onSelectionChange?.({ detail: { selectedItems: [] } });
                      }
                    }}
                  />
                </th>
              )}
              {columnDefinitions.map((col: any) => (
                <th
                  key={col.id}
                  style={{
                    width: col.width,
                    textAlign: "left",
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--border-2)",
                  }}
                >
                  <div className="eyebrow" style={{ fontSize: "10px", color: "var(--text-3)" }}>
                    {col.header}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={columnDefinitions.length + (selectionType === "multi" ? 1 : 0)} style={{ textAlign: "center", padding: "40px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <Spinner size="large" />
                    <span style={{ fontSize: "12px", color: "var(--text-3)" }}>{loadingText || "Loading..."}</span>
                  </div>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={columnDefinitions.length + (selectionType === "multi" ? 1 : 0)} style={{ textAlign: "center", padding: "40px", color: "var(--text-3)" }}>
                  {empty || "No items"}
                </td>
              </tr>
            ) : (
              items.map((item: any, idx: number) => {
                const isSelected = isItemSelected(item);
                return (
                  <tr
                    key={keyOf(item) ?? idx}
                    onClick={() => onRowClick?.({ detail: { item } })}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      background: isSelected ? "var(--accent-soft)" : "transparent",
                      opacity: loading ? 0.6 : 1,
                      transition: "opacity 0.25s ease",
                      cursor: onRowClick ? "pointer" : "default",
                    }}
                  >
                    {selectionType === "multi" && (
                      <td style={{ padding: "10px 16px" }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            const nextSelected = e.target.checked
                              ? [...(selectedItems || []), item]
                              : (selectedItems || []).filter((si: any) => keyOf(si) !== keyOf(item));
                            onSelectionChange?.({ detail: { selectedItems: nextSelected } });
                          }}
                        />
                      </td>
                    )}
                    {columnDefinitions.map((col: any) => (
                      <td key={col.id} style={{ padding: "12px 16px", fontSize: "13px", color: "var(--text-2)" }}>
                        {col.cell(item)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {pagination && (
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border-2)", background: "var(--bg-2)" }}>
          {pagination}
        </div>
      )}
    </div>
  );
}

// 19. Modal
interface ModalProps {
  children?: React.ReactNode;
  visible?: boolean;
  onDismiss?: () => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  size?: string;
  className?: string;
  closeAriaLabel?: string;
}

export function Modal({ children, visible, onDismiss, header, footer }: ModalProps) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(11, 12, 15, 0.75)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 20,
      }}
    >
      <div
        className="scroller"
        style={{
          width: "100%",
          maxWidth: "560px",
          background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "16px", fontWeight: 800, letterSpacing: "-0.01em" }}>{header}</span>
          <button type="button" onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)" }}>
            <X size={16} />
          </button>
        </div>
        <div className="scroller" style={{ padding: "20px", overflowY: "auto", flex: 1 }}>{children}</div>
        {footer && (
          <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", background: "var(--bg-2)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// 20. Link
interface LinkProps {
  children?: React.ReactNode;
  href?: string;
  external?: boolean;
  variant?: string;
  onClick?: (event: any) => void;
  fontSize?: string;
  onFollow?: (event: any) => void;
}

export function Link({ children, href, external, onClick, onFollow, fontSize }: LinkProps) {
  const handleClick = (e: React.MouseEvent) => {
    if (onClick) onClick(e);
    if (onFollow) onFollow(e);
  };
  return (
    <a
      href={href}
      onClick={handleClick}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      style={{
        color: "var(--accent)",
        textDecoration: "none",
        fontSize: fontSize || "13px",
        fontWeight: 500,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
    >
      {children}
    </a>
  );
}

// 22. Form
interface FormProps {
  children?: React.ReactNode;
  actions?: React.ReactNode;
  header?: React.ReactNode;
}

export function Form({ children, actions, header }: FormProps) {
  return (
    <form style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {header && <div style={{ marginBottom: 12 }}>{header}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
      {actions && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          {actions}
        </div>
      )}
    </form>
  );
}

// 23. SegmentedControl
interface SegmentedControlOption {
  id: string;
  text: string;
}

interface SegmentedControlProps {
  selectedId?: string;
  onChange?: (event: { detail: { selectedId: string } }) => void;
  options: SegmentedControlOption[];
  className?: string;
  label?: string;
}

export function SegmentedControl({ selectedId, onChange, options, className }: SegmentedControlProps) {
  return (
    <div className={clsx("seg", className)}>
      {options.map((opt: any) => {
        const isSelected = opt.id === selectedId;
        return (
          <button
            key={opt.id}
            type="button"
            className={isSelected ? "on" : ""}
            onClick={() => onChange?.({ detail: { selectedId: opt.id } })}
          >
            {opt.text}
          </button>
        );
      })}
    </div>
  );
}

// 24. TextFilter
interface TextFilterProps {
  filteringText?: string;
  onChange?: (event: { detail: { filteringText: string } }) => void;
  filteringPlaceholder?: string;
  countText?: string;
}

export function TextFilter({ filteringText, onChange, filteringPlaceholder, countText }: TextFilterProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
      <Input
        value={filteringText}
        placeholder={filteringPlaceholder}
        onChange={({ detail }) => onChange?.({ detail: { filteringText: detail.value } })}
      />
      {countText && <span style={{ fontSize: "11px", color: "var(--text-3)" }}>{countText}</span>}
    </div>
  );
}

// 25. ButtonDropdown
export interface ButtonDropdownOption {
  id: string;
  text: string;
  items?: ButtonDropdownOption[];
  disabled?: boolean;
  disabledReason?: string;
}

export interface ButtonDropdownProps {
  children?: React.ReactNode;
  items: ButtonDropdownOption[];
  onItemClick?: (event: { detail: { id: string } }) => void;
  variant?: string;
  expandToViewport?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  loading?: boolean;
}

export namespace ButtonDropdownProps {
  export type ItemOrGroup = ButtonDropdownOption;
}

export function ButtonDropdown({ children, items, onItemClick, disabled, expandToViewport }: ButtonDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState({ top: 0, left: 0, showAbove: false });

  const updateCoords = React.useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      // If space below is less than 250px and we have more space above, render above
      const showAbove = spaceBelow < 250 && spaceAbove > spaceBelow;
      
      const top = showAbove ? rect.top - 4 : rect.bottom + 4;
      const left = Math.min(window.innerWidth - 208, Math.max(8, rect.right - 200));
      
      setCoords({ top, left, showAbove });
    }
  }, []);

  React.useEffect(() => {
    if (open && expandToViewport) {
      updateCoords();
      window.addEventListener("scroll", updateCoords, true);
      window.addEventListener("resize", updateCoords);
      return () => {
        window.removeEventListener("scroll", updateCoords, true);
        window.removeEventListener("resize", updateCoords);
      };
    }
  }, [open, expandToViewport, updateCoords]);

  React.useEffect(() => {
    const clickAway = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        if (expandToViewport && dropdownRef.current && dropdownRef.current.contains(e.target as Node)) {
          return;
        }
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", clickAway);
    return () => document.removeEventListener("mousedown", clickAway);
  }, [expandToViewport]);

  const triggerLabel = children || "Actions";

  const renderItem = (item: ButtonDropdownOption) => {
    if (item.items) {
      return (
        <div key={item.text} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 4, marginBottom: 4 }}>
          <div className="eyebrow" style={{ fontSize: "9px", padding: "6px 12px 2px", color: "var(--text-3)" }}>{item.text}</div>
          {item.items.map((sub) => renderItem(sub))}
        </div>
      );
    }
    const itemDisabled = item.disabled || false;
    return (
      <button
        key={item.id}
        type="button"
        disabled={itemDisabled}
        title={item.disabledReason}
        onClick={() => {
          if (!itemDisabled) {
            onItemClick?.({ detail: { id: item.id } });
            setOpen(false);
          }
        }}
        style={{
          width: "100%",
          textAlign: "left",
          background: "transparent",
          color: itemDisabled ? "var(--text-4)" : "var(--text-2)",
          border: "none",
          padding: "6px 12px",
          cursor: itemDisabled ? "not-allowed" : "pointer",
          fontSize: "12.5px",
          display: "block",
          opacity: itemDisabled ? 0.5 : 1,
        }}
        onMouseEnter={(e) => {
          if (!itemDisabled) e.currentTarget.style.background = "var(--surface-3)";
        }}
        onMouseLeave={(e) => {
          if (!itemDisabled) e.currentTarget.style.background = "transparent";
        }}
      >
        {item.text}
      </button>
    );
  };

  const dropdownMenu = open && (
    <div
      ref={dropdownRef}
      className="scroller"
      style={{
        position: expandToViewport ? "fixed" : "absolute",
        top: expandToViewport ? coords.top : "105%",
        left: expandToViewport ? coords.left : undefined,
        right: expandToViewport ? undefined : 0,
        transform: (expandToViewport && coords.showAbove) ? "translateY(-100%)" : undefined,
        width: "200px",
        background: "var(--surface-2)",
        border: "1px solid var(--border-3)",
        borderRadius: "var(--r-sm)",
        zIndex: 10000,
        maxHeight: "300px",
        overflowY: "auto",
        boxShadow: "var(--shadow)",
        padding: "4px 0",
      }}
    >
      {items.map((item) => renderItem(item))}
    </div>
  );

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={buttonRef}
        type="button"
        className="field"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: disabled ? "not-allowed" : "pointer",
          width: "100%",
          textAlign: "left",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={14} style={{ color: "var(--text-3)", marginLeft: 6 }} />
      </button>

      {open && (expandToViewport ? createPortal(dropdownMenu, document.body) : dropdownMenu)}
    </div>
  );
}

// 26. Badge
const BADGE_TOKENS: Record<string, [string, string]> = {
  green: ["--ok", "--ok-soft"],
  red: ["--down", "--down-soft"],
  blue: ["--accent", "--accent-soft"],
  amber: ["--warning", "--warning-soft"],
  "severity-medium": ["--warning", "--warning-soft"],
  grey: ["--text-2", "--surface-3"],
};

export function Badge({ children, color }: any) {
  const [tcVar, bgVar] = BADGE_TOKENS[color as string] ?? BADGE_TOKENS.grey;
  // Fallback to --surface-3 keeps the pill visible if a token ever drifts again.
  const bg = `var(${bgVar}, var(--surface-3))`;
  const tc = `var(${tcVar})`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: "99px",
        fontSize: "11px",
        fontWeight: 600,
        background: bg,
        color: tc,
      }}
    >
      {children}
    </span>
  );
}

// 27. StatusIndicator
export function StatusIndicator({ children, type }: any) {
  const dotColor =
    type === "success"
      ? "var(--ok)"
      : type === "warning"
      ? "var(--afk)"
      : type === "stopped" || type === "error"
      ? "var(--down)"
      : type === "pending" || type === "info" || type === "in-progress"
      ? "var(--active)"
      : "var(--text-3)";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: "13px", color: "var(--text-2)" }}>
      <div className="dot" style={{ background: dotColor, width: 7, height: 7, boxShadow: "none" }} />
      <span>{children}</span>
    </div>
  );
}

export interface DateRangePickerProps {
  value: DateRangePickerProps.Value | null;
  onChange?: (event: { detail: DateRangePickerProps.ChangeDetail }) => void;
  relativeOptions?: DateRangePickerProps.RelativeOption[];
  isValidRange?: (value: DateRangePickerProps.Value | null) => DateRangePickerProps.ValidationResult;
  i18nStrings?: DateRangePickerProps.I18nStrings;
  placeholder?: string;
  rangeFormatHeader?: string;
  dateOnly?: boolean;
  ariaLabel?: string;
  showClearButton?: boolean;
  expandToViewport?: boolean;
  granularity?: string;
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <input
        type="date"
        className="field"
        value={value?.type === "absolute" ? value.startDate : ""}
        onChange={(e) => {
          const nextVal: DateRangePickerProps.Value = {
            type: "absolute",
            startDate: e.target.value,
            endDate: value?.type === "absolute" ? value.endDate : e.target.value,
            amount: 0,
            unit: "day",
          };
          onChange?.({ detail: { value: nextVal } });
        }}
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border-3)",
          borderRadius: "var(--r-sm)",
          color: "var(--text)",
          padding: "4px 8px",
          outline: "none",
          fontSize: "12px",
        }}
      />
      <span style={{ color: "var(--text-3)", fontSize: "11px" }}>to</span>
      <input
        type="date"
        className="field"
        value={value?.type === "absolute" ? value.endDate : ""}
        onChange={(e) => {
          const nextVal: DateRangePickerProps.Value = {
            type: "absolute",
            startDate: value?.type === "absolute" ? value.startDate : e.target.value,
            endDate: e.target.value,
            amount: 0,
            unit: "day",
          };
          onChange?.({ detail: { value: nextVal } });
        }}
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border-3)",
          borderRadius: "var(--r-sm)",
          color: "var(--text)",
          padding: "4px 8px",
          outline: "none",
          fontSize: "12px",
        }}
      />
    </div>
  );
}

export namespace DateRangePickerProps {
  export interface RelativeOption {
    key: string;
    type: "relative";
    amount: number;
    unit: string;
  }
  export interface I18nStrings {
    modeSelectionLabel?: string;
    relativeModeTitle?: string;
    absoluteModeTitle?: string;
    relativeRangeSelectionHeading?: string;
    relativeRangeSelectionMonthlyDescription?: string;
    cancelButtonLabel?: string;
    clearButtonLabel?: string;
    applyButtonLabel?: string;
    formatRelativeRange?: (value: any) => string;
    formatUnit?: (unit: any, value: number) => string;
    customRelativeRangeOptionLabel?: string;
    customRelativeRangeOptionDescription?: string;
    customRelativeRangeDurationLabel?: string;
    customRelativeRangeDurationPlaceholder?: string;
    customRelativeRangeUnitLabel?: string;
    startDateLabel?: string;
    startTimeLabel?: string;
    endDateLabel?: string;
    endTimeLabel?: string;
    dateConstraintText?: string;
    monthConstraintText?: string;
    isoDatePlaceholder?: string;
  }
  export type TimeUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";
  export interface Value {
    type: "relative" | "absolute";
    startDate?: string;
    endDate?: string;
    amount?: number;
    unit?: TimeUnit;
  }
  export interface ValidationResult {
    valid: boolean;
    errorMessage?: string;
  }
  export interface ChangeDetail {
    value: Value | null;
  }
}

// 29. ContentLayout
interface ContentLayoutProps {
  children?: React.ReactNode;
  header?: React.ReactNode;
  disableHeaderPaddings?: boolean;
}

export function ContentLayout({ children, header }: ContentLayoutProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", minHeight: "100%" }}>
      {header && (
        <div style={{ padding: "24px 32px", background: "var(--bg-2)", borderBottom: "1px solid var(--border)" }}>
          {header}
        </div>
      )}
      <div style={{ padding: "32px" }}>{children}</div>
    </div>
  );
}

// 30. ExpandableSection
interface ExpandableSectionProps {
  children?: React.ReactNode;
  headerText?: React.ReactNode;
  variant?: string;
  defaultExpanded?: boolean;
  headerDescription?: string;
}

export function ExpandableSection({ children, headerText, defaultExpanded, headerDescription }: ExpandableSectionProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded ?? false);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r)", background: "var(--surface)", overflow: "hidden", marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          background: "var(--bg-2)",
          border: "none",
          color: "var(--text)",
          fontWeight: 700,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <div>
          <span>{headerText}</span>
          {headerDescription && <div style={{ fontSize: "11px", fontWeight: 400, color: "var(--text-3)", marginTop: 4 }}>{headerDescription}</div>}
        </div>
        <span style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
          <ChevronDown size={16} />
        </span>
      </button>
      {expanded && <div style={{ padding: "0 16px 16px", borderTop: "1px solid var(--border)" }}>{children}</div>}
    </div>
  );
}

// 31. ProgressBar
interface ProgressBarProps {
  value?: number;
  label?: React.ReactNode;
  description?: React.ReactNode;
  additionalInfo?: React.ReactNode;
}

export function ProgressBar({ value = 0, label, description, additionalInfo }: ProgressBarProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", margin: "8px 0" }}>
      {label && <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text)" }}>{label}</div>}
      {description && <div style={{ fontSize: "11px", color: "var(--text-3)" }}>{description}</div>}
      <div style={{ width: "100%", height: 8, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, Math.max(0, value))}%`, height: "100%", background: "var(--accent)", transition: "width 0.2s" }} />
      </div>
      {additionalInfo && <div style={{ fontSize: "11px", color: "var(--text-4)" }}>{additionalInfo}</div>}
    </div>
  );
}

// 32. Pagination
interface PaginationProps {
  currentPageIndex: number;
  pagesCount: number;
  onChange?: (event: { detail: { currentPageIndex: number } }) => void;
  ariaLabel?: string;
}

export function Pagination({ currentPageIndex, pagesCount, onChange }: PaginationProps) {
  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    height: 32,
    borderRadius: "var(--r-sm)",
    border: "1px solid var(--border-2)",
    background: "var(--surface-2)",
    color: "var(--text)",
    fontSize: "13px",
    fontFamily: "var(--sans)",
    fontWeight: 600,
    lineHeight: 1,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    display: "inline-flex",
    alignItems: "center",
  });
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", margin: "16px 0" }}>
      <button
        type="button"
        disabled={currentPageIndex <= 1}
        onClick={() => onChange?.({ detail: { currentPageIndex: currentPageIndex - 1 } })}
        style={btnStyle(currentPageIndex <= 1)}
      >
        Previous
      </button>
      <span style={{
        padding: "0 14px",
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        fontSize: "13px",
        fontFamily: "var(--sans)",
        color: "var(--text-2)",
      }}>
        Page {currentPageIndex} of {pagesCount}
      </span>
      <button
        type="button"
        disabled={currentPageIndex >= pagesCount}
        onClick={() => onChange?.({ detail: { currentPageIndex: currentPageIndex + 1 } })}
        style={btnStyle(currentPageIndex >= pagesCount)}
      >
        Next
      </button>
    </div>
  );
}

// 33. BreadcrumbGroup
interface BreadcrumbItem {
  text: string;
  href: string;
}

interface BreadcrumbGroupProps {
  items: BreadcrumbItem[];
  onFollow?: (event: { detail: BreadcrumbItem; preventDefault: () => void }) => void;
}

export function BreadcrumbGroup({ items, onFollow }: BreadcrumbGroupProps) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: "12.5px" }}>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <React.Fragment key={idx}>
            {idx > 0 && <span style={{ color: "var(--text-4)" }}>/</span>}
            {isLast ? (
              <span style={{ color: "var(--text-3)", fontWeight: 500 }}>{item.text}</span>
            ) : (
              <a
                href={item.href}
                onClick={(e) => {
                  if (onFollow) {
                    onFollow({
                      detail: item,
                      preventDefault: () => e.preventDefault(),
                    });
                  }
                }}
                style={{ color: "var(--accent)", textDecoration: "none" }}
              >
                {item.text}
              </a>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// 35. Icon
import { Folder, File as FileIcon } from "lucide-react";

interface IconProps {
  name: string;
  size?: "small" | "medium" | "large" | string;
}

export function Icon({ name, size }: IconProps) {
  const s = size === "small" ? 14 : size === "large" ? 22 : 18;
  if (name === "folder") return <Folder size={s} style={{ color: "var(--accent)", fill: "var(--accent-soft)", display: "inline-block", verticalAlign: "middle" }} />;
  return <FileIcon size={s} style={{ color: "var(--text-3)", display: "inline-block", verticalAlign: "middle" }} />;
}

// 36. BarChart
export function BarChart({ series, height, yTickFormatter }: any) {
  const data = series?.[0]?.data || [];
  const maxVal = Math.max(...data.map((d: any) => d.y), 1);
  return (
    <div style={{ height: height || 200, display: "flex", flexDirection: "column", gap: 10, width: "100%", padding: "10px 0" }}>
      <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 8, borderBottom: "1px solid var(--border-2)", paddingBottom: 6 }}>
        {data.map((item: any, idx: number) => {
          const pct = (item.y / maxVal) * 100;
          return (
            <div
              key={idx}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                height: "100%",
                justifyContent: "flex-end",
              }}
            >
              <div
                style={{
                  width: "100%",
                  maxWidth: "40px",
                  height: `${pct}%`,
                  background: "var(--accent)",
                  borderRadius: "4px 4px 0 0",
                  position: "relative",
                  transition: "height 0.3s ease",
                  cursor: "pointer",
                }}
                title={`${item.x}: ${yTickFormatter ? yTickFormatter(item.y) : item.y}`}
              />
              <div
                style={{
                  fontSize: "10px",
                  color: "var(--text-3)",
                  width: "100%",
                  textAlign: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.x}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
