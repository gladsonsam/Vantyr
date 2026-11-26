import { Card, CardContent } from "@vantyr/ui/components/card";
import StatusMark from "@/components/react-bits/StatusMark";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { usePolicyQuery } from "@/features/network/runtime/useRuntimeQueries";
import { RuleGroup } from "./RuleList";

/**
 * The rules that apply to this device before anyone is verified on it: the household baseline, then the
 * device's own defaults. Person rules join in only when a person is verified.
 */
export function DeviceRules({ deviceId }: { deviceId: string }) {
  const query = usePolicyQuery();
  if (query.isPending) return null;
  if (query.isError) {
    return <UnavailableSection title="Rules in effect" reason="Couldn’t load the rules." />;
  }
  if (query.data.state === "unavailable") {
    return <UnavailableSection title="Rules in effect" reason={query.data.reason} />;
  }
  const applied = query.data.data.applied;
  if (!applied) {
    return (
      <UnavailableSection
        title="Rules in effect"
        reason="No policy has been applied yet, so nothing is being enforced for this device."
      />
    );
  }
  const deviceRules = applied.deviceDefaults.find((s) => s.scopeId === deviceId)?.rules ?? [];
  const proposal = query.data.data.proposal;
  const waiting = proposal && proposal.revision > applied.revision ? proposal : null;
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-6 p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="font-medium">Rules in effect</h3>
          <span className="text-sm text-muted-foreground">Revision {applied.revision}</span>
        </div>
        {waiting ? (
          <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3 text-sm">
            <StatusMark status="pending" size={20} color="var(--muted-foreground)" />
            <span className="text-muted-foreground">
              Revision {waiting.revision} is saved but not applied. It changes nothing for this
              device until the gateways apply it.
            </span>
          </div>
        ) : null}
        <RuleGroup title="Household baseline" rules={applied.baseline} empty="No baseline rules." />
        <RuleGroup
          title="This device’s defaults"
          rules={deviceRules}
          empty="No rules of its own."
        />
        <p className="text-sm text-muted-foreground">
          Anything else is {applied.defaultEffect === "allow" ? "allowed" : "blocked"} by the
          household default. A person’s own rules apply only once they are verified on the device.
        </p>
      </CardContent>
    </Card>
  );
}
