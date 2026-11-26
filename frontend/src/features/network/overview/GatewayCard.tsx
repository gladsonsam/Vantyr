import { Link } from "react-router-dom";
import { AlertTriangle, Info, Network, Server } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { SettingsRow, SettingsSection } from "@/features/settings/components/SettingsLayout";
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
    <SettingsSection
      title={gateway.name}
      icon={<Icon />}
      description={
        <>
          Last report <TimeAgo iso={gateway.lastSeenAt} />
        </>
      }
      action={<OnlineStatus online={gateway.online} />}
      variant="plain"
    >
      <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
        <KeyValueCard label="Applied revision" format="text">
          {gateway.appliedRevision === null ? (
            "None"
          ) : (
            <>
              {gateway.appliedRevision}
              <span className="font-normal text-muted-foreground">
                {" "}
                · acknowledged <TimeAgo iso={gateway.acknowledgedAt} />
              </span>
            </>
          )}
        </KeyValueCard>
        <KeyValueCard
          label={
            <span className="flex items-center gap-1.5">
              Verification
              <HelpTip label="About verification">
                Acknowledging a revision only means the gateway received it. Verified means a check
                from the gateway confirmed the rules behave as expected.
              </HelpTip>
            </span>
          }
          format="custom"
        >
          <div className="flex flex-wrap items-center gap-3">
            <VerificationStatus verification={gateway.verification} />
            {gateway.verifiedAt ? (
              <span className="text-sm text-muted-foreground">
                <TimeAgo iso={gateway.verifiedAt} />
              </span>
            ) : null}
          </div>
        </KeyValueCard>
      </KeyValueGrid>

      <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70 bg-card/10">
        {gateway.capabilities.map((capability) => (
          <SettingsRow
            key={capability.id}
            label={CAPABILITY_LABEL[capability.id]}
            help={capability.detail}
            layout="switch"
          >
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Gateway reports</span>
              <CoverageStatus coverage={capability.coverage} />
            </span>
          </SettingsRow>
        ))}
        {gateway.warnings.length > 0 ? (
          <ul className="space-y-3 px-5 py-4">
            {gateway.warnings.map((warning) => (
              <Warning key={warning.id} warning={warning} />
            ))}
          </ul>
        ) : null}
      </div>
    </SettingsSection>
  );
}
