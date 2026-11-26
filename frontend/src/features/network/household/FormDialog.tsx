import { useState, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
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

/** A short admin form in a dialog. `onSubmit` rejects to show its message; resolving closes it. */
export function FormDialog({
  trigger,
  title,
  description,
  submitLabel,
  canSubmit,
  disabledReason,
  onSubmit,
  onReset,
  children,
}: {
  trigger: string;
  title: string;
  description?: string;
  submitLabel: string;
  canSubmit: boolean;
  /** Shown instead of the form fields when something the form needs doesn't exist yet. */
  disabledReason?: string;
  onSubmit: () => Promise<unknown>;
  onReset: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setError(null);
      onReset();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
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
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus /> {trigger}
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
