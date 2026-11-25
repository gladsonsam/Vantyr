import { X } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";

/** A failure message above the list, with Try again or Dismiss when there is something to do about it. */
export function PageNotice({ message, onRetry, onDismiss }: { message: string; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 flex-1 break-words">{message}</span>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
        {onDismiss && (
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
            <X />
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
