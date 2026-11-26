import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";

/**
 * A settings card whose data could not be loaded. It deliberately has no form: blank fields would read as
 * "nothing is set" and saving them would overwrite what the server still holds.
 */
export function LoadFailedCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="gap-0 py-0 border-destructive/30">
      <CardContent className="p-5 text-sm">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{message}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
