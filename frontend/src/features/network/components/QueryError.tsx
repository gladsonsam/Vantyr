import { ShieldOff } from "lucide-react";
import { isApiError } from "@/api";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { SettingsSection } from "./SettingsSection";
import { UnavailableSection } from "./AvailabilityGate";

/**
 * The failure of one Network query: a denied scope and a missing API are stated as such (and say
 * nothing about other households); anything else is a retryable load failure.
 */
export function QueryError({
  title,
  error,
  scope,
  onRetry,
}: {
  title: string;
  error: unknown;
  /** What access this screen needs, e.g. "network_admin". */
  scope: string;
  onRetry: () => void;
}) {
  if (isApiError(error) && error.status === 403) {
    return (
      <SettingsSection title={title} icon={<ShieldOff />} bodyClassName="px-5 py-4">
        <p className="text-sm text-muted-foreground">
          Your account doesn’t have the {scope} grant on this household. Platform administrators
          don’t get it automatically; ask a network administrator.
        </p>
      </SettingsSection>
    );
  }
  if (isApiError(error) && error.status === 404) {
    return (
      <UnavailableSection
        title={title}
        reason="This server doesn’t provide this part of Vantyr Network."
      />
    );
  }
  return <LoadFailedCard message={`Couldn’t load ${title.toLowerCase()}.`} onRetry={onRetry} />;
}
