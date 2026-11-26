import { Plus, Search, X } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@vantyr/ui/components/input-group";

/** A failure that stays on the page until it is dismissed or retried. */
export function ErrorBanner({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words">{message}</span>
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** What last succeeded, dismissible. */
export function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <p
      role="status"
      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
    >
      <span className="min-w-0 break-words">{message}</span>
      <Button variant="ghost" size="xs" aria-label="Dismiss message" onClick={onDismiss}>
        <X />
      </Button>
    </p>
  );
}

/** Why a save or delete failed, shown inside the dialog that asked for it (the page behind it is out of sight). */
export function DialogError({
  prefix,
  message,
}: {
  prefix: string;
  message: string | null | undefined;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg bg-destructive/10 px-3 py-2 text-sm break-words text-destructive"
    >
      {prefix}: {message}
    </div>
  );
}

export function RuleSearch({
  label,
  placeholder,
  query,
  onChange,
}: {
  label: string;
  placeholder: string;
  query: string;
  onChange: (query: string) => void;
}) {
  return (
    <InputGroup className="h-9 min-w-0 sm:max-w-md">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        placeholder={placeholder}
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/** The line above a list: what is in it, and the button that adds to it. */
export function RuleToolbar({
  summary,
  createLabel,
  onCreate,
}: {
  summary: string;
  createLabel: string;
  onCreate: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p role="status" className="text-sm text-muted-foreground tabular-nums">
        {summary}
      </p>
      <Button onClick={onCreate}>
        <Plus /> {createLabel}
      </Button>
    </div>
  );
}
