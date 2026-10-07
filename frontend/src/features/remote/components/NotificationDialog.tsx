import type { RefObject } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogOverlay, DialogTitle } from "@/components/ui/dialog";
import { InputField } from "@/components/common/form/fields";
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
          <NotificationForm canSend={canSend} onSend={onSend} onClose={() => onOpenChange(false)} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

const notificationSchema = z.object({
  title: z.string().refine((value) => value.trim().length > 0, "Title is required"),
  message: z.string(),
});
type NotificationValues = z.infer<typeof notificationSchema>;

function NotificationForm({ canSend, onSend, onClose }: {
  canSend: boolean;
  onSend: (title: string, message: string) => boolean;
  onClose: () => void;
}) {
  const form = useForm<NotificationValues>({
    resolver: zodResolver(notificationSchema),
    mode: "onChange",
    defaultValues: { title: "", message: "" },
  });

  const send = form.handleSubmit(({ title, message }) => {
    if (!onSend(title, message)) return;
    onClose();
  });

  return (
    <form onSubmit={send} noValidate className="contents">
      <div className="flex flex-col gap-4">
        <InputField
          control={form.control}
          name="title"
          id="remote-notification-title"
          label="Title"
          aria-label="Notification title"
          maxLength={64}
          placeholder="Notification title"
          hideError
        />
        <InputField
          control={form.control}
          name="message"
          id="remote-notification-message"
          label="Message"
          aria-label="Notification message"
          maxLength={256}
          placeholder="Optional message"
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSend || !form.formState.isValid}>
          Send
        </Button>
      </DialogFooter>
    </form>
  );
}
