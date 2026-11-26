import { ShieldOff } from "lucide-react";
import { useParams } from "react-router-dom";
import { isApiError } from "@/api";
import { useDnsStatus } from "@/api/queries/dnsManagement";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { DnsStatusPanel } from "./DnsStatusPanel";

/**
 * Scoped, events-only DNS status for one household, addressed by the id in the URL. Outside the
 * administrator-only Network layout: it calls only the status endpoint, never households or
 * inventory, so a person with just the Network events permission can use it.
 */
export function DnsStatusPage() {
  const { householdId = "" } = useParams();
  usePageHeader({
    title: "DNS status",
    description: "What the DNS workers last reported for this household.",
  });
  const status = useDnsStatus(householdId);
  const code = status.isError && isApiError(status.error) ? status.error.status : 0;
  if (code === 401 || code === 403 || code === 404) {
    return (
      <EmptyState
        title="You need the Network events permission for this household."
        description="Ask a network administrator to grant it."
        icon={<ShieldOff className="size-5" />}
        iconVariant="icon"
      />
    );
  }
  return (
    <div className="mx-auto w-full max-w-3xl">
      <DnsStatusPanel householdId={householdId} />
    </div>
  );
}
