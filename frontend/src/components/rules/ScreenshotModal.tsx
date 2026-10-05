import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiUrl } from "../../lib/api";

interface ScreenshotModalProps {
  eventId: number | null;
  onClose: () => void;
}

export function ScreenshotModal({ eventId, onClose }: ScreenshotModalProps) {
  return (
    <Dialog open={eventId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Screenshot</DialogTitle>
        </DialogHeader>
        {eventId != null && (
          <div className="flex justify-center rounded-xl bg-muted/50 p-2">
            <img
              src={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
              alt="Alert trigger screenshot"
              className="max-h-[70vh] max-w-full rounded-lg object-contain"
            />
          </div>
        )}
        <DialogFooter>
          {eventId != null && (
            <Button variant="outline" render={<a href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)} target="_blank" rel="noreferrer" />}>
              <ExternalLink /> Open
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
