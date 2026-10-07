import { useState, type RefObject } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogOverlay, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Compose a desktop notification for the controlled device. `onSend` returns whether it was
 * sent; the draft is kept until then.
 */
export function NotificationDialog({
  open,
  onOpenChange,
  containerRef,
  canSend,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rendered inside the viewer so it stays visible while maximized. */
  containerRef: RefObject<HTMLDivElement | null>;
  canSend: boolean;
  onSend: (title: string, message: string) => boolean;
}) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  const send = () => {
    if (!title.trim()) return;
    if (!onSend(title, message)) return;
    onOpenChange(false);
    setTitle("");
    setMessage("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Custom container (not document.body): the dialog must stay inside the
          viewer's fullscreen tree so it remains visible while maximized. */}
      <DialogPrimitive.Portal container={containerRef}>
        <DialogOverlay />
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn(
            "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm",
          )}
        >
          <DialogHeader>
            <DialogTitle>Send notification</DialogTitle>
          </DialogHeader>
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
          </DialogPrimitive.Close>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="remote-notification-title">Title</FieldLabel>
              <Input
                id="remote-notification-title"
                aria-label="Notification title"
                maxLength={64}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Notification title"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="remote-notification-message">Message</FieldLabel>
              <Input
                id="remote-notification-message"
                aria-label="Notification message"
                maxLength={256}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Optional message"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={send} disabled={!canSend || !title.trim()}>
              Send
            </Button>
          </DialogFooter>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}
