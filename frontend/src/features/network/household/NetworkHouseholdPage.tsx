import { useQuery } from "@tanstack/react-query";
import { Ban, Cable, Laptop, Link2, Users } from "lucide-react";
import { errorText } from "@/api";
import { networkQueries, useUpdateConnectionMutation } from "@/api/queries/network";
import type {
  NetworkAssignment,
  NetworkConnection,
  NetworkDevice,
  NetworkPerson,
} from "@/api/types";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard } from "@/components/common/resource-detail/KeyValueCard";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { useNetworkAdmin } from "@/features/network/access/useNetworkAdmin";
import { PageLoading } from "@/features/network/components/PageLoading";
import { QueryError } from "@/features/network/components/QueryError";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import {
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/SettingsLayout";
import { useState, type ReactNode } from "react";
import { AddConnectionForm, AddDeviceForm, AddPersonForm, AssignForm } from "./HouseholdForms";
import { KIND_LABEL, ROLE_LABEL, STATUS_TONE, TYPE_LABEL } from "./labels";

function Dot({ text, label }: { text: string; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${text}`}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

const Empty = ({ children }: { children: string }) => (
  <p className="px-5 py-4 text-sm text-muted-foreground">{children}</p>
);

function PeopleSection({
  persons,
  action,
}: {
  persons: NetworkPerson[];
  action: ReactNode;
}) {
  return (
    <SettingsSection title="People" icon={<Users />} action={action}>
      {persons.length === 0 ? (
        <Empty>No people yet.</Empty>
      ) : (
        persons.map((person) => (
          <SettingsRow
            key={person.id}
            label={person.display_name}
            description={person.is_default_profile ? "Default profile" : undefined}
            layout="switch"
          />
        ))
      )}
    </SettingsSection>
  );
}

function DevicesSection({
  devices,
  ownerOf,
  action,
}: {
  devices: NetworkDevice[];
  ownerOf: (device: NetworkDevice) => string | null;
  action: ReactNode;
}) {
  return (
    <SettingsSection
      title="Devices"
      icon={<Laptop />}
      action={action}
      help="Devices belong to the household. A person is linked through an assignment, and a device can have none. Devices can’t be edited or deleted here."
    >
      {devices.length === 0 ? (
        <Empty>No devices yet.</Empty>
      ) : (
        devices.map((device) => {
          const owner = ownerOf(device);
          return (
            <SettingsRow
              key={device.id}
              label={device.label}
              description={`${TYPE_LABEL[device.device_type]}${device.shared ? " · Shared" : ""}`}
              layout="switch"
            >
              <span className="text-sm text-muted-foreground">
                {owner ? `Owner: ${owner}` : "No owner"}
              </span>
            </SettingsRow>
          );
        })
      )}
    </SettingsSection>
  );
}

function AssignmentsSection({
  assignments,
  personName,
  deviceName,
  action,
}: {
  assignments: NetworkAssignment[];
  personName: (id: string) => string;
  deviceName: (id: string) => string;
  action: ReactNode;
}) {
  return (
    <SettingsSection title="Assignments" icon={<Link2 />} action={action}>
      {assignments.length === 0 ? (
        <Empty>Nobody is assigned to a device.</Empty>
      ) : (
        assignments.map((a) => (
          <SettingsRow
            key={a.id}
            label={`${personName(a.person_id)} uses ${deviceName(a.device_id)}`}
            description={ROLE_LABEL[a.role]}
            layout="switch"
          >
            <Dot
              text={a.active ? "text-success" : "text-muted-foreground"}
              label={a.active ? "Active" : "Inactive"}
            />
          </SettingsRow>
        ))
      )}
    </SettingsSection>
  );
}

function ConnectionRow({
  connection,
  agentLabel,
  household,
  isAdmin,
}: {
  connection: NetworkConnection;
  agentLabel: string | null;
  household: string;
  isAdmin: boolean;
}) {
  const update = useUpdateConnectionMutation(household);
  const [error, setError] = useState<string | null>(null);
  const tone = STATUS_TONE[connection.revoked_at ? "revoked" : connection.status];
  const revoked = connection.status === "revoked" || connection.revoked_at !== null;
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-3 text-sm font-medium">
            {KIND_LABEL[connection.kind]}
            <Dot {...tone} />
          </div>
          <div className="text-[0.8125rem] text-muted-foreground">
            Last seen <TimeAgo iso={connection.last_seen_at} />
            {" · "}
            {agentLabel ? `Linked agent ${agentLabel}` : "No linked agent"}
          </div>
        </div>
        {isAdmin && !revoked ? (
          <HoldAction
            icon={<Ban className="size-4" />}
            ariaLabel={`Hold to revoke ${KIND_LABEL[connection.kind]} connection`}
            doneLabel="Revoked"
            disabled={update.isPending}
            onHold={() =>
              update.mutate(
                { id: connection.id, status: "revoked", revoked_at: new Date().toISOString() },
                { onError: (e) => setError(errorText(e)) },
              )
            }
          >
            Hold to revoke
          </HoldAction>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** People, devices, who uses what, and how each device connects. Reads for all; writes for admins. */
export function NetworkHouseholdPage() {
  const household = useNetworkHousehold();
  const isAdmin = useNetworkAdmin(household.id);
  const persons = useQuery(networkQueries.persons(household.id));
  const devices = useQuery(networkQueries.devices(household.id));
  const assignments = useQuery(networkQueries.assignments(household.id));
  const connections = useQuery(networkQueries.connections(household.id));

  const failed = [persons, devices, assignments, connections].find((q) => q.isError);
  const header = (
    <SettingsPageHeader
      title={
        <span className="flex items-center gap-2">
          Household
          <HelpTip label="About the household">
            Connection status and last seen are reports, not verified. People and devices can’t be
            deleted or renamed from here.
          </HelpTip>
        </span>
      }
      description="The people and devices Vantyr Network applies to."
    />
  );
  if (failed) {
    return (
      <div className="space-y-8">
        {header}
        <QueryError
          title="Household"
          error={failed.error}
          scope="network_admin"
          onRetry={() => void failed.refetch()}
        />
      </div>
    );
  }
  if (!persons.data || !devices.data || !assignments.data || !connections.data) {
    return <PageLoading />;
  }

  const personList = persons.data.persons;
  const deviceList = devices.data.devices;
  const assignmentList = assignments.data.assignments;
  const connectionList = connections.data.connections;
  const personName = (id: string) =>
    personList.find((p) => p.id === id)?.display_name ?? "Unknown person";
  const deviceName = (id: string) => deviceList.find((d) => d.id === id)?.label ?? "Unknown device";
  const ownerOf = (device: NetworkDevice) => {
    const owner = assignmentList.find(
      (a) => a.device_id === device.id && a.role === "owner" && a.active,
    );
    return owner ? personName(owner.person_id) : null;
  };
  const agentFor = (c: NetworkConnection) => {
    const id =
      c.enrolled_agent_id ??
      assignmentList.find((a) => a.id === c.assignment_id)?.agent_id ??
      null;
    return id ? id.slice(0, 8) : null;
  };
  const withConnections = deviceList.filter((d) => connectionList.some((c) => c.device_id === d.id));

  return (
    <div className="space-y-8">
      {header}
      <SettingsSection title="Household" variant="plain">
        <div className="grid gap-3 sm:grid-cols-2">
          <KeyValueCard label="Name" format="text">
            {household.name}
          </KeyValueCard>
          <KeyValueCard label="Timezone" format="text">
            {household.timezone}
          </KeyValueCard>
        </div>
      </SettingsSection>
      <PeopleSection
        persons={personList}
        action={isAdmin ? <AddPersonForm household={household.id} /> : null}
      />
      <DevicesSection
        devices={deviceList}
        ownerOf={ownerOf}
        action={isAdmin ? <AddDeviceForm household={household.id} /> : null}
      />
      <AssignmentsSection
        assignments={assignmentList}
        personName={personName}
        deviceName={deviceName}
        action={
          isAdmin ? (
            <AssignForm household={household.id} persons={personList} devices={deviceList} />
          ) : null
        }
      />
      <SettingsSection
        title="Connections"
        icon={<Cable />}
        variant="plain"
        help="How each device reaches Vantyr. Status and last seen are what was reported or entered, not verified."
        action={isAdmin ? <AddConnectionForm household={household.id} devices={deviceList} /> : null}
      >
        {withConnections.length === 0 ? (
          <div className="rounded-xl border border-border/70 bg-card/10">
            <Empty>No connections yet.</Empty>
          </div>
        ) : (
          <div className="space-y-4">
            {withConnections.map((device) => (
              <div
                key={device.id}
                className="overflow-hidden rounded-xl border border-border/70 bg-card/10"
              >
                <div className="border-b border-border/50 px-5 py-3 text-sm font-semibold">
                  {device.label}
                </div>
                <ul className="divide-y divide-border/50">
                  {connectionList
                    .filter((c) => c.device_id === device.id)
                    .map((c) => (
                      <ConnectionRow
                        key={c.id}
                        connection={c}
                        agentLabel={agentFor(c)}
                        household={household.id}
                        isAdmin={isAdmin}
                      />
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
