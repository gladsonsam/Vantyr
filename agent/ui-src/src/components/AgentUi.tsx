import { forwardRef, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { CheckCircle2, Loader2, Shield, X, XCircle } from "lucide-react";
import type { NoticeTone, StatusResponse } from "../types";
import { classNames } from "../lib/utils";

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="agent-spin" aria-hidden="true" />;
}

export function Button({
  children,
  variant = "secondary",
  loading = false,
  icon,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...props}
      className={classNames("agent-btn", `agent-btn--${variant}`, className)}
      disabled={props.disabled || loading}
    >
      {loading ? <Spinner /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <label className="agent-field">
      <span className="agent-field__label">{label}</span>
      {description ? <span className="agent-field__description">{description}</span> : null}
      {children}
    </label>
  );
}

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input {...props} ref={ref} className={classNames("agent-input", props.className)} />;
  },
);

export function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={classNames("agent-input", "agent-select", props.className)} />;
}

export function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="agent-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className="agent-toggle__track" aria-hidden="true">
        <span className="agent-toggle__thumb" />
      </span>
      <span>{children}</span>
    </label>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  const icon =
    tone === "success" ? <CheckCircle2 size={16} /> : tone === "error" ? <XCircle size={16} /> : <Shield size={16} />;
  return (
    <div className={classNames("agent-notice", `agent-notice--${tone}`)} role={tone === "error" ? "alert" : "status"}>
      {icon}
      <div>
        {title ? <div className="agent-notice__title">{title}</div> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  children,
  actions,
  onClose,
  locked = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  locked?: boolean;
}) {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, locked]);

  if (!open) return null;

  return (
    <div className="agent-modal" role="presentation">
      <div className="agent-modal__scrim" aria-hidden="true" />
      <dialog className="agent-modal__panel" aria-label={title} open>
        <div className="agent-modal__header">
          <h2>{title}</h2>
          <button
            type="button"
            className="agent-icon-btn"
            aria-label="Close dialog"
            disabled={locked}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="agent-modal__body">{children}</div>
        {actions ? <div className="agent-modal__actions">{actions}</div> : null}
      </dialog>
    </div>
  );
}

export function ConnectionStatusPill({ status, message }: StatusResponse) {
  const tone =
    status === "Connected" ? "success" : status === "Connecting" ? "progress" : status === "Error" ? "error" : "idle";
  const label = status === "Error" && message ? `Error: ${message}` : status;

  return (
    <span className={classNames("agent-status-pill", `agent-status-pill--${tone}`)}>
      {status === "Connecting" ? <Spinner /> : <span className="agent-status-pill__dot" />}
      {label}
    </span>
  );
}

export function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="agent-stat-card">
      <div className="agent-stat-card__label">{label}</div>
      <div className="agent-stat-card__value">{value}</div>
    </div>
  );
}
