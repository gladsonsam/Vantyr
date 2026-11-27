import { useState } from "react";
import { Info, ShieldCheck } from "lucide-react";
import { errorText } from "@/api";
import {
  NETWORK_SETUP_PURPOSES,
  type NetworkOwnDevice,
  type NetworkSetupPurpose,
  type NetworkVerifiedSession,
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
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { SettingsCardBody, SettingsSection } from "@/features/settings/components/SettingsLayout";
import { fmtDateTime } from "@/lib/utils";
import { PURPOSE_LABEL, purposeLabel } from "./enrollLib";

/** The verified session a consume returned, with its honest limits stated up front. */
export function VerifiedSessionCard({
  session,
  deviceLabel,
}: {
  session: NetworkVerifiedSession;
  deviceLabel: string;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-card/10 p-5">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="text-sm font-medium">
          This is session evidence only. It does not prove who is using a shared device, and it does
          not prove that any traffic is routed or protected.
        </p>
      </div>
      <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
        <KeyValueCard label="Device" format="text">
          {deviceLabel}
        </KeyValueCard>
        <KeyValueCard label="Purpose" format="text">
          {purposeLabel(session.purpose)}
        </KeyValueCard>
        <KeyValueCard label="Verified by" format="text">
          Verified by dashboard sign-in session
        </KeyValueCard>
        <KeyValueCard label="Session ends" format="text" title={fmtDateTime(session.expires_at)}>
          <TimeAgo iso={session.expires_at} />
        </KeyValueCard>
        <KeyValueCard label="Network coverage" format="text">
          Unverified
        </KeyValueCard>
      </KeyValueGrid>
      <p className="text-[0.8125rem] text-muted-foreground">{session.note}</p>
    </div>
  );
}

/** Paste a grant id and secret to exchange them for a verified session. */
export function ConsumeSection({
  devices,
  verifying,
  error,
  session,
  onConsume,
}: {
  devices: NetworkOwnDevice[];
  verifying: boolean;
  error: unknown;
  session: NetworkVerifiedSession | null;
  onConsume: (body: {
    grant_id: string;
    secret: string;
    purpose: NetworkSetupPurpose;
    device_id: string;
  }) => void;
}) {
  const [grantId, setGrantId] = useState("");
  const [secret, setSecret] = useState("");
  const [device, setDevice] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<NetworkSetupPurpose>("proxy_setup");
  const ready = grantId.trim() && secret.trim() && device;

  return (
    <SettingsSection
      title="Verify a device"
      icon={<ShieldCheck />}
      description="Exchange a setup grant for a verified session."
      help="Verification checks the grant against your signed-in dashboard session. A session lasts at most 8 hours, and a device has one live session at a time."
    >
      <SettingsCardBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="consume-grant">Grant id</Label>
            <Input
              id="consume-grant"
              value={grantId}
              onChange={(event) => setGrantId(event.target.value)}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="consume-secret">Secret</Label>
            <Input
              id="consume-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="consume-device">Device</Label>
            <Select value={device} onValueChange={(v) => setDevice(v as string | null)}>
              <SelectTrigger id="consume-device" className="w-full">
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
            <Label htmlFor="consume-purpose">Purpose</Label>
            <Select value={purpose} onValueChange={(v) => setPurpose(v as NetworkSetupPurpose)}>
              <SelectTrigger id="consume-purpose" className="w-full">
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
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(error)}
          </p>
        ) : null}
        <div>
          <Button
            disabled={!ready || verifying}
            onClick={() => {
              if (!device) return;
              onConsume({
                grant_id: grantId.trim(),
                secret: secret.trim(),
                purpose,
                device_id: device,
              });
              setSecret("");
            }}
          >
            {verifying ? <Spinner /> : null} Verify device
          </Button>
        </div>
        {session ? (
          <VerifiedSessionCard
            session={session}
            deviceLabel={
              devices.find((d) => d.id === session.device_id)?.label ?? session.device_id
            }
          />
        ) : null}
      </SettingsCardBody>
    </SettingsSection>
  );
}
