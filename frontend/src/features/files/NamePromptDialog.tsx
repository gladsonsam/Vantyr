import { useState } from "react";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Input } from "@vantyr/ui/components/input";

/**
 * A dialog asking for one name or path (new folder, new file, rename, move). The value is
 * seeded from `initialValue` each time the dialog opens; `onSubmit` gets it trimmed.
 */
export function NamePromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder = label,
  initialValue = "",
  submitLabel,
  disabled = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Accessible name of the input. */
  label: string;
  placeholder?: string;
  initialValue?: string;
  submitLabel: string;
  /** Extra reasons the submit button is unavailable (an empty value always disables it). */
  disabled?: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initialValue);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription className="wrap-break-word">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            // Enter in the field confirms, like the button.
            e.preventDefault();
            if (!value.trim() || disabled) return;
            onOpenChange(false);
            onSubmit(value.trim());
          }}
        >
          <Input
            aria-label={label}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim() || disabled}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
