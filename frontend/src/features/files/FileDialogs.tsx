import { useState } from "react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@vantyr/ui/components/dialog";
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
          <DialogTitle>{preview.title ? `Preview: ${preview.title}` : "Preview"}</DialogTitle>
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

/** Confirm deleting the selection; `onConfirm` gets whether folders go recursively. */
export function DeleteFilesDialog({
  open,
  onOpenChange,
  subject,
  busy,
  disabled,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `"name"` for one item, `N items` for several. */
  subject: string;
  busy: boolean;
  disabled: boolean;
  onConfirm: (recursive: boolean) => void;
}) {
  const [recursive, setRecursive] = useState(true);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {subject}?</AlertDialogTitle>
          <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={recursive} onCheckedChange={(checked) => setRecursive(checked === true)} />
          Delete folders recursively
        </label>
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
