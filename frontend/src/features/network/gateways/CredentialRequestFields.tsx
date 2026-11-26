import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import { HelpTip } from "@/components/common/HelpTip";
import type { CredentialRequestValues } from "./credentialRequest";

/** Expiry and allowed commands for a worker token. Heartbeat is always included. */
export function CredentialRequestFields({
  values,
  onChange,
  idPrefix,
}: {
  values: CredentialRequestValues;
  onChange: (values: CredentialRequestValues) => void;
  idPrefix: string;
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
            asked to run. Nothing else is granted.
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
      </div>
    </div>
  );
}
