import { useState, type RefObject } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";

/** Read-only text preview of a downloaded file. */
export function FilePreviewDialog({
  preview,
  onClose,
}: {
  preview: { open: boolean; title: string; text: string; loading: boolean };
  onClose: () => void;
}) {
  return (
    <Dialog
      open={preview.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="wrap-break-word">
            {preview.title ? `Preview: ${preview.title}` : "Preview"}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-xl bg-muted/50 p-3">
          <pre className="m-0 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
            {preview.loading ? "Loading…" : preview.text || "(Empty file.)"}
          </pre>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LISTED_NAMES = 5;

/** Confirm deleting the selection; `onConfirm` gets whether folders go recursively. */
export function DeleteFilesDialog({
  open,
  onOpenChange,
  returnFocus,
  subject,
  names,
  folderCount,
  location,
  busy,
  disabled,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null>;
  /** `"name"` for one item, `N items` for several. */
  subject: string;
  /** Names of everything that will be deleted (the first few are listed). */
  names: string[];
  /** How many of them are folders. */
  folderCount: number;
  /** The folder they are in, so it is clear where they are deleted from. */
  location: string;
  busy: boolean;
  disabled: boolean;
  onConfirm: (recursive: boolean) => void;
}) {
  const [recursive, setRecursive] = useState(true);
  const listed = names.slice(0, LISTED_NAMES);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        finalFocus={returnFocus}
        className="max-h-[calc(100dvh-1rem)] overflow-y-auto"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-break-word">Delete {subject}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes {names.length === 1 ? "it" : "them"} from the device. It can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {names.length > 1 || location ? (
          <div className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-lg bg-muted/50 px-3 py-2 text-[13px]">
            {location ? (
              <p className="font-mono text-xs break-all text-muted-foreground">{location}</p>
            ) : null}
            {names.length > 1 ? (
              <ul className="flex flex-col gap-0.5">
                {listed.map((name) => (
                  <li key={name} className="wrap-break-word">
                    {name}
                  </li>
                ))}
                {names.length > listed.length ? (
                  <li className="text-muted-foreground">and {names.length - listed.length} more</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
        {folderCount > 0 ? (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={recursive}
              onCheckedChange={(checked) => setRecursive(checked === true)}
            />
            <span>
              Delete folders recursively
              <span className="block text-xs text-muted-foreground">
                Turn off to delete only empty folders.
              </span>
            </span>
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disabled || busy}
            onClick={() => {
              onOpenChange(false);
              onConfirm(recursive);
            }}
          >
            {busy && <Spinner />} Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
