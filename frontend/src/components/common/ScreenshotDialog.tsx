import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiUrl } from "@/lib/api";

interface ScreenshotDialogProps {
  /** Alert rule event whose screenshot to show; `null` closes the dialog. */
  eventId: number | null;
  onClose: () => void;
  title?: string;
}

/** Preview of the screenshot captured when an alert rule fired. */
export function ScreenshotDialog({ eventId, onClose, title = "Screenshot" }: ScreenshotDialogProps) {
  const src = eventId != null ? apiUrl(`/alert-rule-events/${eventId}/screenshot`) : null;
  return (
    <Dialog open={eventId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {src && (
          <div className="flex justify-center rounded-xl bg-muted/50 p-2">
            <img
              src={src}
              alt="Alert trigger screenshot"
              className="max-h-[70vh] max-w-full rounded-lg object-contain"
            />
          </div>
        )}
        <DialogFooter>
          {src && (
            <Button variant="outline" render={<a href={src} target="_blank" rel="noopener noreferrer" />}>
              <ExternalLink /> Open in new tab
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
