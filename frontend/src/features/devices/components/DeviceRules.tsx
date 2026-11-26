import { Card, CardContent } from "@vantyr/ui/components/card";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { usePolicyQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { PolicyRule } from "@/features/network/runtime/types";
import { matchText } from "@/features/devices/lib/format";
import { cn } from "@/lib/utils";

function RuleLine({ rule }: { rule: PolicyRule }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 text-sm">
      <span className="flex items-baseline gap-3">
        <span
          className={cn(
            "w-12 font-medium",
            rule.effect === "deny" ? "text-destructive" : "text-success",
          )}
        >
          {rule.effect === "deny" ? "Block" : "Allow"}
        </span>
        <span className="font-mono text-[0.8125rem]">{matchText(rule.match)}</span>
      </span>
      <span className="text-muted-foreground">{rule.reason}</span>
    </li>
  );
}

function Group({ title, rules, empty }: { title: string; rules: PolicyRule[]; empty: string }) {
  return (
    <div>
      <h4 className="text-sm font-medium">{title}</h4>
      {rules.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-1 divide-y divide-border">
          {rules.map((rule) => (
            <RuleLine key={rule.id} rule={rule} />
          ))}
        </ul>
      )}
    </div>
  );
}

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
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-6 p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="font-medium">Rules in effect</h3>
          <span className="text-sm text-muted-foreground">Revision {applied.revision}</span>
        </div>
        <Group title="Household baseline" rules={applied.baseline} empty="No baseline rules." />
        <Group title="This device’s defaults" rules={deviceRules} empty="No rules of its own." />
        <p className="text-sm text-muted-foreground">
          Anything else is {applied.defaultEffect === "allow" ? "allowed" : "blocked"} by the
          household default. A person’s own rules apply only once they are verified on the device.
        </p>
      </CardContent>
    </Card>
  );
}
