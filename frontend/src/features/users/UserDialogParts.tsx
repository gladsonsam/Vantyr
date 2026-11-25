import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@vantyr/ui/components/alert-dialog";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";

/** Why an action failed, shown inside the dialog that asked for it (the page behind it is out of sight). */
export function DialogError({ prefix, message }: { prefix: string; message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">
      {prefix}: {message}
    </div>
  );
}

/** A failure that stays on the page until it is retried. */
export function ErrorBanner({ message, onRetry, retrying = false }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words">{message}</span>
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
          {retrying && <Spinner />} Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Asks before an account action that takes effect right away, saying what will happen. It stays open (and
 * can't be dismissed) while the request is in flight, and a failure is reported here, not behind it.
 */
export function ConfirmUserDialog({ open, pending, title, confirmLabel, destructive = false, finalFocus, error, errorPrefix, children, onClose, onConfirm }: {
  open: boolean;
  pending: boolean;
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  finalFocus?: () => HTMLElement | null;
  error: string | null;
  errorPrefix: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <AlertDialogContent finalFocus={finalFocus} className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription render={<div className="flex flex-col gap-2" />}>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <DialogError prefix={errorPrefix} message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
            {pending && <Spinner />} {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
