import type { ReactNode } from "react";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Skeleton } from "@vantyr/ui/components/skeleton";

/**
 * The frame of a rule's history: title, a one-line summary, a load failure with Try again, then the list.
 * A failed load never reads as "nothing happened yet".
 */
export function HistoryDialog({
  open,
  title,
  summary,
  loading,
  error,
  errorPrefix,
  empty,
  emptyText,
  onRetry,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  summary: string;
  loading: boolean;
  /** Why the history could not be loaded, when it could not. */
  error: string | null;
  errorPrefix: string;
  empty: boolean;
  emptyText: string;
  onRetry: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-[min(48rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle className="break-words">{title}</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>
        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span className="min-w-0 break-words">
              {errorPrefix}: {error}
            </span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {loading ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : !empty ? (
          children
        ) : error ? null : (
          <p className="rounded-xl border border-border/60 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        )}
        <DialogFooter className="-bottom-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
