import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <Input aria-label={label} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!value.trim() || disabled}
            onClick={() => {
              onOpenChange(false);
              onSubmit(value.trim());
            }}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
