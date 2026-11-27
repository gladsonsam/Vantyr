import { useState, type ReactNode } from "react";
import {
  useCreateAssignmentMutation,
  useCreateConnectionMutation,
  useCreateDeviceMutation,
  useCreatePersonMutation,
  useUpdateAssignmentMutation,
  useUpdateConnectionMutation,
  useUpdateHouseholdMutation,
  useUpdateDeviceMutation,
  useUpdatePersonMutation,
} from "@/api/queries/network";
import {
  NETWORK_ASSIGNMENT_ROLES,
  NETWORK_CONNECTION_KINDS,
  NETWORK_CONNECTION_STATUSES,
  NETWORK_DEVICE_TYPES,
  type NetworkAssignment,
  type NetworkAssignmentRole,
  type NetworkConnection,
  type NetworkConnectionStatus,
  type NetworkConnectionKind,
  type NetworkDevice,
  type NetworkDeviceType,
  type NetworkHousehold,
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
import { DeleteInventorySection } from "./DeleteInventorySection";
import { FormDialog } from "./FormDialog";
import { KIND_LABEL, ROLE_LABEL, STATUS_TONE, TYPE_LABEL } from "./labels";

function Field({
  label,
  id,
  help,
  children,
}: {
  label: string;
  id: string;
  help?: string;
  children: ReactNode;
}) {
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

const UNLINK_HELP =
  "Unlinking only edits this inventory record. It does not unenroll a monitoring agent, revoke agent or worker credentials, end a BYOD session, or establish or remove verified network coverage.";

/** The note as sent in a PATCH: omitted when untouched, null only when the user emptied a stored note. */
function notePatch(draft: string, stored: string | null): { note?: string | null } {
  const next = draft.trim();
  if (next === (stored ?? "")) return {};
  return { note: next.length > 0 ? next : null };
}

function NoteField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Note" id={id} help="Clearing the text and saving removes the stored note.">
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={500}
      />
    </Field>
  );
}

/** An explicit, staged clear: nothing is sent unless it is ticked and the form is saved. */
function UnlinkOption({
  id,
  label,
  confirm,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  confirm: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} />
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        <HelpTip label={`About ${label.toLowerCase()}`}>{UNLINK_HELP}</HelpTip>
      </div>
      {checked ? <p className="pl-6 text-destructive">{confirm}</p> : null}
    </div>
  );
}

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** Name and timezone. Only edited fields are sent; the server reports which ones changed. */
export function EditHouseholdForm({ household }: { household: NetworkHousehold }) {
  const update = useUpdateHouseholdMutation(household.id);
  const [name, setName] = useState(household.name);
  const [timezone, setTimezone] = useState(household.timezone);
  const nameChanged = name.trim() !== household.name;
  const zoneChanged = timezone.trim() !== household.timezone;
  return (
    <FormDialog
      edit
      trigger="Edit household"
      title="Edit household"
      submitLabel="Save"
      canSubmit={
        name.trim().length > 0 && timezone.trim().length > 0 && (nameChanged || zoneChanged)
      }
      onSubmit={async () => {
        const result = await update.mutateAsync({
          ...(nameChanged ? { name: name.trim() } : {}),
          ...(zoneChanged ? { timezone: timezone.trim() } : {}),
        });
        const fields = result.changed_fields;
        return {
          notice: fields.length === 0 ? "No changes" : `Saved: ${fields.join(", ")}`,
        };
      }}
      onReset={() => {
        setName(household.name);
        setTimezone(household.timezone);
      }}
    >
      <Field label="Name" id="household-name">
        <Input
          id="household-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          autoFocus
        />
      </Field>
      <Field
        label="Timezone"
        id="household-timezone"
        help="Recorded configuration only. Changing it does not republish policy, change the policy’s own timezone, digest or desired assignment, or mean anything is being enforced in that zone."
      >
        <Input
          id="household-timezone"
          list="household-timezones"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          placeholder="Region/City, for example Europe/London"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="household-timezones">
          {COMMON_TIMEZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p className="text-[0.8125rem] text-muted-foreground">
          IANA name, such as Africa/Lagos or UTC.
        </p>
      </Field>
    </FormDialog>
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
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "device"
  );
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
        <Checkbox
          id="device-shared"
          checked={shared}
          onCheckedChange={(c) => setShared(c === true)}
        />
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
      onSubmit={() =>
        create.mutateAsync({ device_id: device as string, kind, provenance: "manual" })
      }
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

const NONE = "none";

export function EditPersonForm({
  household,
  person,
}: {
  household: string;
  person: NetworkPerson;
}) {
  const update = useUpdatePersonMutation(household);
  const [name, setName] = useState(person.display_name);
  const [isDefault, setIsDefault] = useState(person.is_default_profile);
  const [note, setNote] = useState(person.note ?? "");
  const noteChanged = note.trim() !== (person.note ?? "");
  const changed =
    name.trim() !== person.display_name || isDefault !== person.is_default_profile || noteChanged;
  return (
    <FormDialog
      edit
      trigger="Edit"
      title={`Edit ${person.display_name}`}
      submitLabel="Save"
      canSubmit={name.trim().length > 0 && changed}
      onSubmit={() =>
        update.mutateAsync({
          id: person.id,
          ...(name.trim() !== person.display_name ? { display_name: name.trim() } : {}),
          ...(isDefault !== person.is_default_profile ? { is_default_profile: isDefault } : {}),
          ...notePatch(note, person.note),
        })
      }
      onReset={() => {
        setName(person.display_name);
        setIsDefault(person.is_default_profile);
        setNote(person.note ?? "");
      }}
      footerExtra={
        <DeleteInventorySection household={household} kind="person" id={person.id} noun="person" />
      }
    >
      <Field label="Name" id={`person-name-${person.id}`}>
        <Input
          id={`person-name-${person.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          autoFocus
        />
      </Field>
      <NoteField id={`person-note-${person.id}`} value={note} onChange={setNote} />
      <div className="flex items-center gap-2 text-sm">
        <Checkbox
          id={`person-default-${person.id}`}
          checked={isDefault}
          onCheckedChange={(c) => setIsDefault(c === true)}
        />
        <Label htmlFor={`person-default-${person.id}`} className="font-normal">
          Default profile
        </Label>
        <HelpTip label="About the default profile">
          Marks one person as the household’s default profile. Only one person can hold it at a
          time: saving this clears it from whoever had it before. It is a profile marker, not proof
          of who is using a device.
        </HelpTip>
      </div>
    </FormDialog>
  );
}

export function EditDeviceForm({
  household,
  device,
}: {
  household: string;
  device: NetworkDevice;
}) {
  const update = useUpdateDeviceMutation(household);
  const [label, setLabel] = useState(device.label);
  const [type, setType] = useState<NetworkDeviceType>(device.device_type);
  const [shared, setShared] = useState(device.shared);
  const changed =
    label.trim() !== device.label || type !== device.device_type || shared !== device.shared;
  return (
    <FormDialog
      edit
      trigger="Edit"
      title={`Edit ${device.label}`}
      submitLabel="Save"
      canSubmit={label.trim().length > 0 && changed}
      onSubmit={() =>
        update.mutateAsync({
          id: device.id,
          ...(label.trim() !== device.label ? { label: label.trim() } : {}),
          ...(type !== device.device_type ? { device_type: type } : {}),
          ...(shared !== device.shared ? { shared } : {}),
        })
      }
      onReset={() => {
        setLabel(device.label);
        setType(device.device_type);
        setShared(device.shared);
      }}
      footerExtra={
        <DeleteInventorySection household={household} kind="device" id={device.id} noun="device" />
      }
    >
      <Field label="Name" id={`device-name-${device.id}`}>
        <Input
          id={`device-name-${device.id}`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          autoFocus
        />
      </Field>
      <Field label="Type" id={`device-type-${device.id}`}>
        <Select value={type} onValueChange={(v) => setType(v as NetworkDeviceType)}>
          <SelectTrigger id={`device-type-${device.id}`} className="w-full">
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
        <Checkbox
          id={`device-shared-${device.id}`}
          checked={shared}
          onCheckedChange={(c) => setShared(c === true)}
        />
        <Label htmlFor={`device-shared-${device.id}`} className="font-normal">
          Shared by the household
        </Label>
      </div>
    </FormDialog>
  );
}

export function EditAssignmentForm({
  household,
  assignment,
  title,
}: {
  household: string;
  assignment: NetworkAssignment;
  title: string;
}) {
  const update = useUpdateAssignmentMutation(household);
  const [role, setRole] = useState<NetworkAssignmentRole>(assignment.role);
  const [active, setActive] = useState(assignment.active);
  const [note, setNote] = useState(assignment.note ?? "");
  const [unlinkAgent, setUnlinkAgent] = useState(false);
  const changed =
    role !== assignment.role ||
    active !== assignment.active ||
    note.trim() !== (assignment.note ?? "") ||
    unlinkAgent;
  return (
    <FormDialog
      edit
      trigger="Edit"
      title={title}
      description="To end an assignment but keep its record, set it inactive. Deleting is blocked while connections reference it."
      submitLabel="Save"
      canSubmit={changed}
      onSubmit={() =>
        update.mutateAsync({
          id: assignment.id,
          ...(role !== assignment.role ? { role } : {}),
          ...(active !== assignment.active ? { active } : {}),
          ...notePatch(note, assignment.note),
          // Explicit null unlinks; only sent when the user ticked it and an agent is linked.
          ...(unlinkAgent && assignment.agent_id ? { agent_id: null } : {}),
        })
      }
      onReset={() => {
        setRole(assignment.role);
        setActive(assignment.active);
        setNote(assignment.note ?? "");
        setUnlinkAgent(false);
      }}
      footerExtra={
        <DeleteInventorySection
          household={household}
          kind="assignment"
          id={assignment.id}
          noun="assignment"
        />
      }
    >
      <Field label="Role" id={`assign-role-${assignment.id}`}>
        <Select value={role} onValueChange={(v) => setRole(v as NetworkAssignmentRole)}>
          <SelectTrigger id={`assign-role-${assignment.id}`} className="w-full">
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
      <div className="flex items-center gap-2 text-sm">
        <Checkbox
          id={`assign-active-${assignment.id}`}
          checked={active}
          onCheckedChange={(c) => setActive(c === true)}
        />
        <Label htmlFor={`assign-active-${assignment.id}`} className="font-normal">
          Active
        </Label>
      </div>
      <NoteField id={`assign-note-${assignment.id}`} value={note} onChange={setNote} />
      {assignment.agent_id ? (
        <UnlinkOption
          id={`assign-unlink-agent-${assignment.id}`}
          label="Unlink agent"
          confirm="Saving removes the linked agent from this assignment. The agent itself is not changed."
          checked={unlinkAgent}
          onChange={setUnlinkAgent}
        />
      ) : null}
    </FormDialog>
  );
}

/** Status is an entered report, not a check. Revoking also stamps the revoked time. */
export function EditConnectionForm({
  household,
  connection,
  agents,
  title,
}: {
  household: string;
  connection: NetworkConnection;
  /** Agent ids enrolled in this household. */
  agents: string[];
  title: string;
}) {
  const update = useUpdateConnectionMutation(household);
  const [status, setStatus] = useState<NetworkConnectionStatus>(connection.status);
  const [agent, setAgent] = useState<string>(connection.enrolled_agent_id ?? NONE);
  const current = connection.enrolled_agent_id ?? NONE;
  const options = current !== NONE && !agents.includes(current) ? [current, ...agents] : agents;
  const [note, setNote] = useState(connection.note ?? "");
  const [unlinkAssignment, setUnlinkAssignment] = useState(false);
  const [clearObserved, setClearObserved] = useState(false);
  const [clearLastSeen, setClearLastSeen] = useState(false);
  const changed =
    status !== connection.status ||
    agent !== current ||
    note.trim() !== (connection.note ?? "") ||
    (unlinkAssignment && Boolean(connection.assignment_id)) ||
    (clearObserved && Boolean(connection.observed_at)) ||
    (clearLastSeen && Boolean(connection.last_seen_at));
  return (
    <FormDialog
      edit
      trigger="Edit"
      title={title}
      description="Status is what you enter here, not a check. A connection can be deleted once it is inactive or revoked."
      submitLabel="Save"
      canSubmit={changed}
      onSubmit={() =>
        update.mutateAsync({
          id: connection.id,
          ...(status !== connection.status
            ? {
                status,
                ...(status === "revoked" && !connection.revoked_at
                  ? { revoked_at: new Date().toISOString() }
                  : {}),
                // Explicit null clears the stored revocation time; omitting it would keep it.
                ...(status !== "revoked" && connection.revoked_at ? { revoked_at: null } : {}),
              }
            : {}),
          ...(agent !== current ? { enrolled_agent_id: agent === NONE ? null : agent } : {}),
          ...notePatch(note, connection.note),
          ...(unlinkAssignment && connection.assignment_id ? { assignment_id: null } : {}),
          ...(clearObserved && connection.observed_at ? { observed_at: null } : {}),
          ...(clearLastSeen && connection.last_seen_at ? { last_seen_at: null } : {}),
        })
      }
      onReset={() => {
        setStatus(connection.status);
        setAgent(current);
        setNote(connection.note ?? "");
        setUnlinkAssignment(false);
        setClearObserved(false);
        setClearLastSeen(false);
      }}
      footerExtra={
        <DeleteInventorySection
          household={household}
          kind="connection"
          id={connection.id}
          noun="connection"
          blockedHelp={
            connection.status === "active" ? "Set it inactive or revoked first." : undefined
          }
        />
      }
    >
      <Field
        label="Status"
        id={`conn-status-${connection.id}`}
        help="This is a reported inventory status. Revoking or restoring it does not revoke or reinstate any gateway credential, and it is not a check of the device."
      >
        <Select value={status} onValueChange={(v) => setStatus(v as NetworkConnectionStatus)}>
          <SelectTrigger id={`conn-status-${connection.id}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NETWORK_CONNECTION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_TONE[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Linked agent"
        id={`conn-agent-${connection.id}`}
        help="Only agents already enrolled in this household can be linked."
      >
        <Select value={agent} onValueChange={(v) => setAgent(v as string)}>
          <SelectTrigger id={`conn-agent-${connection.id}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No linked agent</SelectItem>
            {options.map((id) => (
              <SelectItem key={id} value={id}>
                {id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <NoteField id={`conn-note-${connection.id}`} value={note} onChange={setNote} />
      {connection.assignment_id ? (
        <UnlinkOption
          id={`conn-unlink-assignment-${connection.id}`}
          label="Unlink assignment"
          confirm="Saving detaches this connection from its person assignment. The assignment itself stays."
          checked={unlinkAssignment}
          onChange={setUnlinkAssignment}
        />
      ) : null}
      {connection.observed_at ? (
        <UnlinkOption
          id={`conn-clear-observed-${connection.id}`}
          label="Clear observed time"
          confirm="Saving erases the recorded observation time."
          checked={clearObserved}
          onChange={setClearObserved}
        />
      ) : null}
      {connection.last_seen_at ? (
        <UnlinkOption
          id={`conn-clear-seen-${connection.id}`}
          label="Clear last seen"
          confirm="Saving erases the recorded last-seen time."
          checked={clearLastSeen}
          onChange={setClearLastSeen}
        />
      ) : null}
    </FormDialog>
  );
}
