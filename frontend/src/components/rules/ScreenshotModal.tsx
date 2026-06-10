import { Box, Button, Modal, SpaceBetween } from "../ui/console";
import { apiUrl } from "../../lib/api";

interface ScreenshotModalProps {
  eventId: number | null;
  onClose: () => void;
}

export function ScreenshotModal({ eventId, onClose }: ScreenshotModalProps) {
  return (
    <Modal
      visible={eventId != null}
      onDismiss={onClose}
      header="Screenshot"
      size="max"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            {eventId != null && (
              <Button href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)} target="_blank" iconName="external">
                Open
              </Button>
            )}
            <Button variant="link" onClick={onClose}>
              Close
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      {eventId != null && (
        <div style={{ textAlign: "center" }}>
          <img
            src={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
            alt="screenshot"
            style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 6 }}
          />
        </div>
      )}
    </Modal>
  );
}
