import { Spinner } from "@vantyr/ui/components/spinner";
import { Button } from "@vantyr/ui/components/button";
import { useDnsManagement } from "@/api/queries/dnsManagement";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { DnsListsCard } from "./DnsListsCard";
import { DnsServicesCard } from "./DnsServicesCard";
import { CONFLICT_MESSAGE, useDnsEditor } from "./dnsEditor";

/**
 * Filter lists and blocked services, from the DNS management API (admin only). This does not depend
 * on the runtime snapshot. Every write is an operation against the version loaded here.
 */
export function DnsManagementSections({ householdId }: { householdId: string }) {
  const query = useDnsManagement(householdId);
  const desired = query.data?.desired ?? null;
  const editor = useDnsEditor(householdId, desired);

  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/10 py-12 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (query.isError) {
    return (
      <LoadFailedCard
        message="Couldn’t load filter lists and services."
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <div className="space-y-8">
      {editor.conflict ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/10 px-5 py-4 text-sm"
        >
          <span className="text-warning">{CONFLICT_MESSAGE} Reload to see the latest before changing anything.</span>
          <Button variant="outline" size="sm" onClick={editor.reload}>
            Reload
          </Button>
        </div>
      ) : null}
      {editor.error && !editor.conflict ? (
        <p role="alert" className="text-sm text-destructive">
          {editor.error}
        </p>
      ) : null}
      {editor.message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {editor.message}
        </p>
      ) : null}
      <DnsListsCard householdId={householdId} desired={desired} editor={editor} />
      <DnsServicesCard desired={desired} editor={editor} />
    </div>
  );
}
