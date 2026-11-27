import { useState } from "react";
import { Smartphone, Unplug } from "lucide-react";
import { errorText } from "@/api";
import { useEndEnrolledDevice, useRegisterEnrollDevice } from "@/api/queries/network";
import {
  NETWORK_SELF_DEVICE_TYPES,
  type NetworkOwnDevice,
  type NetworkSelfDeviceType,
} from "@/api/types";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { HelpTip } from "@/components/common/HelpTip";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { FormDialog } from "@/features/network/household/FormDialog";
import { SettingsSection } from "@/features/settings/components/SettingsLayout";
import { SELF_DEVICE_TYPE_LABEL, deviceTypeLabel } from "./enrollLib";
import { StatusDot } from "./StatusDot";

function AddDeviceForm({ household }: { household: string }) {
  const register = useRegisterEnrollDevice(household);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<NetworkSelfDeviceType>("phone");
  const [shared, setShared] = useState(false);
  return (
    <FormDialog
      trigger="Add this device"
      title="Add this device"
      description="Registers a new device under your name. It starts as unverified: nothing is routed or protected until it is set up."
      submitLabel="Add device"
      canSubmit={label.trim().length > 0}
      onSubmit={() => register.mutateAsync({ label: label.trim(), device_type: type, shared })}
      onReset={() => {
        setLabel("");
        setType("phone");
        setShared(false);
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="enroll-label">Name</Label>
        <Input
          id="enroll-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          placeholder="e.g. Jo’s phone"
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="enroll-type">Type</Label>
        <Select value={type} onValueChange={(v) => setType(v as NetworkSelfDeviceType)}>
          <SelectTrigger id="enroll-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NETWORK_SELF_DEVICE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {SELF_DEVICE_TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Checkbox
          id="enroll-shared"
          checked={shared}
          onCheckedChange={(c) => setShared(c === true)}
        />
        <Label htmlFor="enroll-shared" className="font-normal">
          Shared with other people
        </Label>
        <HelpTip label="About shared devices">
          On a shared device a sign-in cannot tell who is using it right now, so it is never treated
          as proof of the person at the screen.
        </HelpTip>
      </div>
    </FormDialog>
  );
}

/** The devices enrolled under the signed-in person. */
export function MyDevicesSection({
  household,
  devices,
}: {
  household: string;
  devices: NetworkOwnDevice[];
}) {
  const end = useEndEnrolledDevice(household);
  return (
    <SettingsSection
      title="My devices"
      icon={<Smartphone />}
      description="Devices you have enrolled. Coverage is unverified until a device is set up."
      action={<AddDeviceForm household={household} />}
    >
      {devices.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          You haven’t enrolled a device yet. Add this device to get started.
        </p>
      ) : (
        devices.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{d.label}</div>
              <div className="text-[0.8125rem] text-muted-foreground">
                {deviceTypeLabel(d.device_type)} · {d.shared ? "Shared" : "Personal"}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <StatusDot
                tone={d.enrollment_status === "enrolled" ? "success" : "muted"}
                label={d.enrollment_status === "enrolled" ? "Enrolled" : d.enrollment_status}
              />
              <StatusDot tone="muted" label="Coverage: Unverified" />
              <HoldAction
                icon={<Unplug />}
                ariaLabel={`End enrollment of ${d.label}`}
                doneLabel="Ended"
                disabled={end.isPending}
                onHold={() => end.mutate(d.id)}
              >
                Hold to end enrollment
              </HoldAction>
            </div>
          </div>
        ))
      )}
      {end.isError ? (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {errorText(end.error)}
        </p>
      ) : null}
    </SettingsSection>
  );
}
