import { useState, type FormEvent, type ReactNode } from "react";
import { Pencil, Plus } from "lucide-react";
import { errorText } from "@/api";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";

/** Resolve `onSubmit` with this to keep the dialog open and show the message (e.g. “No changes”). */
export interface FormNotice {
  notice: string;
}

function noticeOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("notice" in result)) return null;
  const { notice } = result as FormNotice;
  return typeof notice === "string" ? notice : null;
}

/** A short admin form in a dialog. `onSubmit` rejects to show its message; resolving closes it. */
export function FormDialog({
  trigger,
  edit = false,
  title,
  description,
  submitLabel,
  canSubmit,
  disabledReason,
  onSubmit,
  onReset,
  footerExtra,
  children,
}: {
  trigger: string;
  /** An edit dialog: a quiet ghost trigger with a pencil instead of the outlined add button. */
  edit?: boolean;
  title: string;
  description?: string;
  submitLabel: string;
  canSubmit: boolean;
  /** Shown instead of the form fields when something the form needs doesn't exist yet. */
  disabledReason?: string;
  onSubmit: () => Promise<unknown>;
  onReset: () => void;
  /** Rendered under the fields and messages, above the footer (e.g. a delete section). */
  footerExtra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const change = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setError(null);
      setNotice(null);
      onReset();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = noticeOf(await onSubmit());
      if (message) {
        setNotice(message);
        return;
      }
      setOpen(false);
      onReset();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger render={<Button variant={edit ? "ghost" : "outline"} size="sm" />}>
        {edit ? <Pencil /> : <Plus />} {trigger}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {disabledReason ? (
            <p className="text-sm text-muted-foreground">{disabledReason}</p>
          ) : (
            children
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {footerExtra}
          <DialogFooter>
            <Button type="submit" disabled={!canSubmit || busy || Boolean(disabledReason)}>
              {busy ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
