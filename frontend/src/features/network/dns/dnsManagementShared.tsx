import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@vantyr/ui/components/button";
import { HelpTip } from "@/components/common/HelpTip";
import { Label } from "@vantyr/ui/components/label";
import { STALE_MESSAGE } from "./dnsEditor";

export function Field({
  label,
  id,
  help,
  error,
  hint,
  children,
}: {
  label: string;
  id: string;
  help?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {help ? <HelpTip label={`About ${label}`}>{help}</HelpTip> : null}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Coloured text with a leading dot; never a chip. */
export function DotText({
  tone,
  children,
}: {
  tone: "success" | "warning" | "destructive" | "muted";
  children: ReactNode;
}) {
  const color = {
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
    muted: "text-muted-foreground",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 ${color}`}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}


/**
 * Render inside a dialog's body (it mounts only while open): pins a fresh basis on open, and shows
 * a non-dismissable notice with Reload when the pinned basis is no longer the latest.
 */
export function DnsBasisGuard({
  stale,
  onOpen,
  onReload,
}: {
  stale: boolean;
  onOpen: () => void;
  onReload: () => void;
}) {
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  }, [onOpen]);
  useLayoutEffect(() => {
    open.current();
  }, []);
  if (!stale) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-4 py-3 text-sm"
    >
      <span className="text-warning">{STALE_MESSAGE}</span>
      <Button type="button" variant="outline" size="sm" onClick={onReload}>
        Reload
      </Button>
    </div>
  );
}
