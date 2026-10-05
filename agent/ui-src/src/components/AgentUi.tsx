import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import type { NoticeTone, StatusResponse } from "../types";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field as FieldPrimitive,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner as SpinnerPrimitive } from "@/components/ui/spinner";

export function Spinner({ className }: { className?: string }) {
  return <SpinnerPrimitive className={className} />;
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
  const inputId = useId();
  const existingId = isValidElement<{ id?: string }>(children)
    ? children.props.id
    : undefined;
  const controlId = existingId ?? inputId;
  const content = isValidElement<{ id?: string }>(children)
    ? cloneElement(children, { id: controlId })
    : children;
  return (
    <FieldPrimitive>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {content}
    </FieldPrimitive>
  );
}

export function TextInput({
  ref,
  ...props
}: React.ComponentProps<typeof Input>) {
  return <Input ref={ref} {...props} />;
}

export function Toggle({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 text-sm font-medium select-none",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex h-[22px] w-[38px] shrink-0 items-center rounded-full border px-[2px] transition-colors",
          "border-input bg-muted peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
          checked && "border-primary/60 bg-primary/25",
        )}
      >
        <span
          className={cn(
            "size-4 rounded-full transition-transform",
            checked
              ? "translate-x-[16px] bg-primary"
              : "bg-muted-foreground",
          )}
        />
      </span>
      <span>{children}</span>
    </label>
  );
}

const NOTICE_ICON: Record<NoticeTone, ReactNode> = {
  success: <CheckCircle2 size={16} />,
  error: <AlertTriangle size={16} />,
  info: <Info size={16} />,
};

export function Notice({
  tone,
  title,
  children,
}: {
  tone: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      className={cn(tone === "success" && "text-success")}
    >
      {NOTICE_ICON[tone]}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription className={cn(tone === "success" && "text-success/90")}>
        {children}
      </AlertDescription>
    </Alert>
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
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !locked) onClose();
      }}
    >
      <DialogContent showCloseButton={!locked}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div>{children}</div>
        {actions ? <DialogFooter>{actions}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Connection state as plain coloured text with a small dot — never a pill
 * badge. Colours come from the shared success / destructive tokens.
 */
export function ConnectionStatus({ status, message }: StatusResponse) {
  const label = status === "Error" && message ? `Error: ${message}` : status;
  if (status === "Connecting") {
    return (
      <span className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {label}
      </span>
    );
  }
  const color =
    status === "Connected"
      ? "text-success"
      : status === "Error"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <span
      className={cn("inline-flex items-center gap-2 text-sm font-medium", color)}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {label}
    </span>
  );
}
