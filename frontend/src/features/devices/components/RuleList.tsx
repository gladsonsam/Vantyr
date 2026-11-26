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

export function RuleGroup({
  title,
  rules,
  empty,
}: {
  title: string;
  rules: PolicyRule[];
  empty: string;
}) {
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
