import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import type { NetworkGatewayKind } from "@/api/types";
import { HelpTip } from "@/components/common/HelpTip";
import type { CredentialRequestValues } from "./credentialRequest";

/** Expiry and allowed commands for a worker token. Heartbeat is always included. */
export function CredentialRequestFields({
  values,
  onChange,
  idPrefix,
  kind = "dns",
}: {
  values: CredentialRequestValues;
  onChange: (values: CredentialRequestValues) => void;
  idPrefix: string;
  kind?: NetworkGatewayKind;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-hours`}>Expires after (hours)</Label>
        <Input
          id={`${idPrefix}-hours`}
          type="number"
          min={1}
          max={720}
          inputMode="numeric"
          value={values.hours}
          onChange={(event) => onChange({ ...values, hours: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Allowed commands
          <HelpTip label="About allowed commands">
            Heartbeat lets the worker report in. Read policy also lets it fetch the policy it is
            asked to run.{" "}
            {kind === "dns"
              ? "Read DNS management lets a DNS worker fetch its list subscriptions, and Report DNS status lets it report what it applied. Report DNS events lets it send the domains it answered as observations; they are not visits or complete history, and events can be lost. Older tokens are never upgraded; request each scope you want. "
              : ""}
            Nothing else is granted.
          </HelpTip>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked disabled aria-label="Heartbeat" /> Heartbeat
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            id={`${idPrefix}-read`}
            checked={values.readPolicy}
            onCheckedChange={(checked) => onChange({ ...values, readPolicy: checked === true })}
          />
          <Label htmlFor={`${idPrefix}-read`} className="font-normal">
            Read policy
          </Label>
        </div>
        {kind === "dns" ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`${idPrefix}-read-dns`}
                checked={values.readDnsManagement}
                onCheckedChange={(checked) =>
                  onChange({ ...values, readDnsManagement: checked === true })
                }
              />
              <Label htmlFor={`${idPrefix}-read-dns`} className="font-normal">
                Read DNS management
              </Label>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`${idPrefix}-report-dns`}
                checked={values.reportDnsStatus}
                onCheckedChange={(checked) =>
                  onChange({ ...values, reportDnsStatus: checked === true })
                }
              />
              <Label htmlFor={`${idPrefix}-report-dns`} className="font-normal">
                Report DNS status
              </Label>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`${idPrefix}-report-events`}
                checked={values.reportDnsEvents}
                onCheckedChange={(checked) =>
                  onChange({ ...values, reportDnsEvents: checked === true })
                }
              />
              <Label htmlFor={`${idPrefix}-report-events`} className="font-normal">
                Report DNS events
              </Label>
              <HelpTip label="About reporting DNS events">
                Lets the DNS worker send the domains it answered as observations. Observations are
                not visits or complete history, and events can be lost.
              </HelpTip>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
