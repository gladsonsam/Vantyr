import { Link } from "react-router-dom";
import { AlertTriangle, Info, Network, Server } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { HelpTip } from "@/components/common/HelpTip";
import { cn } from "@/lib/utils";
import {
  CoverageStatus,
  OnlineStatus,
  VerificationStatus,
} from "@/features/network/components/CoverageStatus";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { CAPABILITY_LABEL } from "@/features/network/lib/labels";
import type { Gateway, GatewayWarning } from "@/features/network/runtime/types";

const WARNING_STYLE: Record<GatewayWarning["severity"], { icon: typeof Info; text: string }> = {
  info: { icon: Info, text: "text-info" },
  warning: { icon: AlertTriangle, text: "text-warning" },
  critical: { icon: AlertTriangle, text: "text-destructive" },
};

function Warning({ warning }: { warning: GatewayWarning }) {
  const { icon: Icon, text } = WARNING_STYLE[warning.severity];
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", text)} aria-hidden="true" />
        {warning.message}
      </span>
      {warning.action ? (
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to={warning.action.to} />}
        >
          {warning.action.label}
        </Button>
      ) : null}
    </li>
  );
}

/** One gateway: is it reporting, what it last applied, and what each capability can honestly claim. */
export function GatewayCard({ gateway }: { gateway: Gateway }) {
  const Icon = gateway.kind === "dns" ? Server : Network;
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
            <div>
              <h3 className="font-medium">{gateway.name}</h3>
              <p className="text-sm text-muted-foreground">
                Last report <TimeAgo iso={gateway.lastSeenAt} />
              </p>
            </div>
          </div>
          <OnlineStatus online={gateway.online} />
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Applied revision</dt>
          <dd>
            {gateway.appliedRevision === null ? (
              "None"
            ) : (
              <>
                {gateway.appliedRevision}
                <span className="text-muted-foreground">
                  {" "}
                  · acknowledged <TimeAgo iso={gateway.acknowledgedAt} />
                </span>
              </>
            )}
          </dd>
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            Verification
            <HelpTip label="About verification">
              Acknowledging a revision only means the gateway received it. Verified means a check
              from the gateway confirmed the rules behave as expected.
            </HelpTip>
          </dt>
          <dd className="flex flex-wrap items-center gap-3">
            <VerificationStatus verification={gateway.verification} />
            {gateway.verifiedAt ? (
              <span className="text-muted-foreground">
                <TimeAgo iso={gateway.verifiedAt} />
              </span>
            ) : null}
          </dd>
        </dl>

        <ul className="divide-y divide-border border-y border-border">
          {gateway.capabilities.map((capability) => (
            <li
              key={capability.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <span className="flex items-center gap-1.5">
                {CAPABILITY_LABEL[capability.id]}
                {capability.detail ? (
                  <HelpTip label={`About ${CAPABILITY_LABEL[capability.id]}`}>
                    {capability.detail}
                  </HelpTip>
                ) : null}
              </span>
              <CoverageStatus coverage={capability.coverage} />
            </li>
          ))}
        </ul>

        {gateway.warnings.length > 0 ? (
          <ul className="space-y-3">
            {gateway.warnings.map((warning) => (
              <Warning key={warning.id} warning={warning} />
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
