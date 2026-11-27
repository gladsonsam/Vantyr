import { useState } from "react";
import { KeyRound } from "lucide-react";
import { errorText } from "@/api";
import { useIssueSetupGrant } from "@/api/queries/network";
import {
  NETWORK_GRANT_MAX_SECS,
  NETWORK_GRANT_MIN_SECS,
  NETWORK_SETUP_PURPOSES,
  type NetworkOwnDevice,
  type NetworkSetupGrantIssued,
  type NetworkSetupPurpose,
} from "@/api/types";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { SettingsCardBody, SettingsSection } from "@/features/settings/components/SettingsLayout";
import { PURPOSE_LABEL } from "./enrollLib";

/** Issue a short-lived setup grant for one of your devices. The secret goes to `onIssued` only. */
export function SetupSection({
  household,
  devices,
  onIssued,
}: {
  household: string;
  devices: NetworkOwnDevice[];
  onIssued: (issued: NetworkSetupGrantIssued) => void;
}) {
  const issue = useIssueSetupGrant(household);
  const [device, setDevice] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<NetworkSetupPurpose>("proxy_setup");
  const [secs, setSecs] = useState("300");
  const n = Number(secs);
  const valid = Number.isInteger(n) && n >= NETWORK_GRANT_MIN_SECS && n <= NETWORK_GRANT_MAX_SECS;

  return (
    <SettingsSection
      title="Setup grant"
      icon={<KeyRound />}
      description="A short-lived, one-time secret for one device."
      help="A setup grant is neither a proxy sign-in credential nor a gateway token, and no certificate or setup script is delivered with it. You exchange it for a verified session below, which is evidence of your dashboard sign-in, not of routed traffic."
      variant="list"
    >
      <SettingsCardBody>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Enroll a device first.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="setup-device">Device</Label>
              <Select value={device} onValueChange={(v) => setDevice(v as string | null)}>
                <SelectTrigger id="setup-device" className="w-full">
                  <SelectValue placeholder="Choose device" />
                </SelectTrigger>
                <SelectContent>
                  {devices.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-purpose">Purpose</Label>
              <Select value={purpose} onValueChange={(v) => setPurpose(v as NetworkSetupPurpose)}>
                <SelectTrigger id="setup-purpose" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NETWORK_SETUP_PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PURPOSE_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-secs">Valid for (seconds)</Label>
              <Input
                id="setup-secs"
                type="number"
                inputMode="numeric"
                min={NETWORK_GRANT_MIN_SECS}
                max={NETWORK_GRANT_MAX_SECS}
                value={secs}
                onChange={(event) => setSecs(event.target.value)}
                aria-invalid={!valid}
              />
              <p className="text-xs text-muted-foreground">
                {NETWORK_GRANT_MIN_SECS} to {NETWORK_GRANT_MAX_SECS} seconds.
              </p>
            </div>
          </div>
        )}
        {issue.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(issue.error)}
          </p>
        ) : null}
        <div>
          <Button
            disabled={!device || !valid || issue.isPending}
            onClick={() =>
              device &&
              issue.mutate(
                { device_id: device, purpose, expires_in_secs: n },
                { onSuccess: onIssued },
              )
            }
          >
            {issue.isPending ? <Spinner /> : null} Issue setup grant
          </Button>
        </div>
      </SettingsCardBody>
    </SettingsSection>
  );
}
