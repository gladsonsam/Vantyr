import { Box, Button } from "./ui/console";
import { apiUrl } from "../lib/api";

/** Screenshot column for alert-rule trigger rows (agent tab or admin history). */
export function AlertRuleEventScreenshotCell(props: {
  eventId: number;
  hasScreenshot: boolean;
  screenshotRequested: boolean;
}) {
  const { eventId, hasScreenshot, screenshotRequested } = props;
  if (hasScreenshot) {
    return (
      <Button
        variant="inline-link"
        href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open
      </Button>
    );
  }
  if (screenshotRequested) {
    return (
      <span title="This rule requests a screenshot, but none was stored for this trigger (capture may have failed or still be in progress).">
        <Box color="text-body-secondary" fontSize="body-s">
          Not captured
        </Box>
      </span>
    );
  }
  return (
    <span title='Turn on "Take screenshot on trigger" on the alert rule to capture an image when it fires.'>
      <Box color="text-body-secondary" fontSize="body-s">
        Off
      </Box>
    </span>
  );
}
