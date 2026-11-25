import type { ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@vantyr/ui/components/alert-dialog";
import { Spinner } from "@vantyr/ui/components/spinner";

/**
 * Asks before an action that takes effect on devices right away, saying what will happen. It stays open
 * (and can't be dismissed) while the request is in flight so the outcome is seen where it was asked for.
 */
export function ConfirmActionDialog({ open, pending, title, confirmLabel, destructive = false, children, onClose, onConfirm }: {
  open: boolean;
  pending: boolean;
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
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
