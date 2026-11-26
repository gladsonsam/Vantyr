import { CAPABILITY_TEXT, capabilitiesFor } from "./gatewayStatusLib";
import type { NetworkGateway } from "@/api/types";

/** Reported capabilities as plain text rows. "Not reported" is an absence of a claim, not a fault. */
export function GatewayCapabilityRows({
  kind,
  reported,
}: {
  kind: NetworkGateway["kind"];
  reported: string[];
}) {
  return (
    <ul className="divide-y divide-border/50">
      {capabilitiesFor(kind).map((id) => {
        const has = reported.includes(id);
        return (
          <li key={id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
            <span>{CAPABILITY_TEXT[id] ?? id}</span>
            <span className={has ? "text-foreground" : "text-muted-foreground"}>
              {has ? "Reported" : "Not reported"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
