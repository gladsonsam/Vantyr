import { useState, type ReactNode } from "react";
import {
  useCreateAssignmentMutation,
  useCreateConnectionMutation,
  useCreateDeviceMutation,
  useCreatePersonMutation,
} from "@/api/queries/network";
import {
  NETWORK_ASSIGNMENT_ROLES,
  NETWORK_CONNECTION_KINDS,
  NETWORK_DEVICE_TYPES,
  type NetworkAssignmentRole,
  type NetworkConnectionKind,
  type NetworkDevice,
  type NetworkDeviceType,
  type NetworkPerson,
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
import { FormDialog } from "./FormDialog";
import { KIND_LABEL, ROLE_LABEL, TYPE_LABEL } from "./labels";

function Field({ label, id, help, children }: { label: string; id: string; help?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {help ? <HelpTip label={`About ${label}`}>{help}</HelpTip> : null}
      </div>
      {children}
    </div>
  );
}

export function AddPersonForm({ household }: { household: string }) {
  const create = useCreatePersonMutation(household);
  const [name, setName] = useState("");
  return (
    <FormDialog
      trigger="Add person"
      title="Add person"
      submitLabel="Add person"
      canSubmit={name.trim().length > 0}
      onSubmit={() => create.mutateAsync({ display_name: name.trim() })}
      onReset={() => setName("")}
    >
      <Field label="Name" id="person-name">
        <Input
          id="person-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoFocus
        />
      </Field>
    </FormDialog>
  );
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "device";
}

/** A device belongs to the household; no person is needed to add one. */
export function AddDeviceForm({ household }: { household: string }) {
  const create = useCreateDeviceMutation(household);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<NetworkDeviceType>("computer");
  const [shared, setShared] = useState(false);
  return (
    <FormDialog
      trigger="Add device"
      title="Add device"
      description="Devices belong to the household. Assign people afterwards, or not at all."
      submitLabel="Add device"
      canSubmit={label.trim().length > 0}
      onSubmit={() =>
        create.mutateAsync({
          canonical_key: `manual:${slug(label)}-${crypto.randomUUID().slice(0, 8)}`,
          label: label.trim(),
          device_type: type,
          shared,
        })
      }
      onReset={() => {
        setLabel("");
        setType("computer");
        setShared(false);
      }}
    >
      <Field label="Name" id="device-name">
        <Input
          id="device-name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          autoFocus
        />
      </Field>
      <Field label="Type" id="device-type">
        <Select value={type} onValueChange={(v) => setType(v as NetworkDeviceType)}>
          <SelectTrigger id="device-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NETWORK_DEVICE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="flex items-center gap-2 text-sm">
        <Checkbox id="device-shared" checked={shared} onCheckedChange={(c) => setShared(c === true)} />
        <Label htmlFor="device-shared" className="font-normal">
          Shared by the household
        </Label>
        <HelpTip label="About shared devices">
          A shared device is used by several people, so no single person’s settings apply to it.
        </HelpTip>
      </div>
    </FormDialog>
  );
}

export function AssignForm({
  household,
  persons,
  devices,
}: {
  household: string;
  persons: NetworkPerson[];
  devices: NetworkDevice[];
}) {
  const create = useCreateAssignmentMutation(household);
  const [person, setPerson] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [role, setRole] = useState<NetworkAssignmentRole>("member");
  const missing =
    persons.length === 0 || devices.length === 0 ? "Add a person and a device first." : undefined;
  return (
    <FormDialog
      trigger="Assign"
      title="Assign person to device"
      submitLabel="Assign"
      disabledReason={missing}
      canSubmit={Boolean(person && device)}
      onSubmit={() =>
        create.mutateAsync({ person_id: person as string, device_id: device as string, role })
      }
      onReset={() => {
        setPerson(null);
        setDevice(null);
        setRole("member");
      }}
    >
      <Field label="Person" id="assign-person">
        <Select value={person} onValueChange={(v) => setPerson(v as string | null)}>
          <SelectTrigger id="assign-person" className="w-full">
            <SelectValue placeholder="Choose person" />
          </SelectTrigger>
          <SelectContent>
            {persons.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Device" id="assign-device">
        <Select value={device} onValueChange={(v) => setDevice(v as string | null)}>
          <SelectTrigger id="assign-device" className="w-full">
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
      </Field>
      <Field label="Role" id="assign-role">
        <Select value={role} onValueChange={(v) => setRole(v as NetworkAssignmentRole)}>
          <SelectTrigger id="assign-role" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NETWORK_ASSIGNMENT_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FormDialog>
  );
}

export function AddConnectionForm({
  household,
  devices,
}: {
  household: string;
  devices: NetworkDevice[];
}) {
  const create = useCreateConnectionMutation(household);
  const [device, setDevice] = useState<string | null>(null);
  const [kind, setKind] = useState<NetworkConnectionKind>("dns");
  return (
    <FormDialog
      trigger="Add connection"
      title="Add connection"
      description="Records how a device reaches Vantyr. Status stays unknown until something reports it."
      submitLabel="Add connection"
      disabledReason={devices.length === 0 ? "Add a device first." : undefined}
      canSubmit={Boolean(device)}
      onSubmit={() => create.mutateAsync({ device_id: device as string, kind, provenance: "manual" })}
      onReset={() => {
        setDevice(null);
        setKind("dns");
      }}
    >
      <Field label="Device" id="conn-device">
        <Select value={device} onValueChange={(v) => setDevice(v as string | null)}>
          <SelectTrigger id="conn-device" className="w-full">
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
      </Field>
      <Field label="Kind" id="conn-kind">
        <Select value={kind} onValueChange={(v) => setKind(v as NetworkConnectionKind)}>
          <SelectTrigger id="conn-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NETWORK_CONNECTION_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FormDialog>
  );
}
