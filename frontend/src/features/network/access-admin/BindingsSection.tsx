import { useState } from "react";
import { ChevronDown, ChevronRight, UserRoundCheck, UserRoundX } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { errorText } from "@/api";
import { networkQueries, useBindingMutations, useBindings } from "@/api/queries/network";
import { userQueries } from "@/api/queries/users";
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
import { HelpTip } from "@/components/common/HelpTip";
import { QueryError } from "@/features/network/components/QueryError";
import { PageLoading } from "@/features/network/components/PageLoading";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { StatusDot } from "@/features/network/enroll/StatusDot";
import { FormDialog } from "@/features/network/household/FormDialog";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { SettingsSection } from "@/features/settings/components/SettingsLayout";
import { DeviceAuthorizations } from "./DeviceAuthorizations";

function AddBindingForm({
  household,
  persons,
  users,
}: {
  household: string;
  persons: { id: string; display_name: string }[];
  users: { id: string; username: string; display_name: string }[] | null;
}) {
  const { create } = useBindingMutations(household);
  const [person, setPerson] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const chosenUser = users ? user : userId.trim() || null;
  return (
    <FormDialog
      trigger="Map a person"
      title="Map a person to a dashboard user"
      description="The user will be able to enroll their own devices as this person, once they also hold the enrollment grant."
      submitLabel="Create mapping"
      disabledReason={persons.length === 0 ? "Add a person on the Household page first." : undefined}
      canSubmit={Boolean(person && chosenUser)}
      onSubmit={() => create.mutateAsync({ person_id: person as string, user_id: chosenUser as string })}
      onReset={() => {
        setPerson(null);
        setUser(null);
        setUserId("");
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="bind-person">Person</Label>
        <Select value={person} onValueChange={(v) => setPerson(v as string | null)}>
          <SelectTrigger id="bind-person" className="w-full">
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
      </div>
      <div className="space-y-2">
        <Label htmlFor="bind-user">Dashboard user</Label>
        {users ? (
          <Select value={user} onValueChange={(v) => setUser(v as string | null)}>
            <SelectTrigger id="bind-user" className="w-full">
              <SelectValue placeholder="Choose user" />
            </SelectTrigger>
            <SelectContent>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.display_name || u.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input
              id="bind-user"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="Dashboard user id"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              The user list isn’t available to your account, so enter the user’s id.
            </p>
          </>
        )}
      </div>
    </FormDialog>
  );
}

/** Principal bindings: which dashboard user acts as which person. */
export function BindingsSection({ household }: { household: string }) {
  const bindings = useBindings(household);
  const persons = useQuery(networkQueries.persons(household));
  const users = useQuery({ ...userQueries.list(), retry: false });
  const { revoke } = useBindingMutations(household);
  const [open, setOpen] = useState<string | null>(null);

  if (bindings.isPending) return <PageLoading />;
  if (bindings.isError)
    return (
      <QueryError
        title="Person mappings"
        error={bindings.error}
        scope="network_admin"
        onRetry={() => void bindings.refetch()}
      />
    );

  const personRows = persons.data?.persons ?? [];
  const userRows = users.data?.users ?? null;
  const personName = (id: string) => personRows.find((p) => p.id === id)?.display_name ?? id;
  const userName = (id: string) => {
    const u = userRows?.find((x) => x.id === id);
    return u ? u.display_name || u.username : id;
  };
  const rows = bindings.data.bindings;

  return (
    <SettingsSection
      title="Person mappings"
      icon={<UserRoundCheck />}
      description="Which dashboard user acts as which person when enrolling their own devices."
      help="A mapping lets an existing dashboard user enroll devices as an existing person. Revoking or changing it ends everything that hung off it: that person’s enrolled devices, setup grants and verified sessions."
      action={<AddBindingForm household={household} persons={personRows} users={userRows} />}
    >
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No one is mapped yet. Map a person to a dashboard user to let them enroll their devices.
        </p>
      ) : (
        rows.map((b) => (
          <div key={b.id}>
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{personName(b.person_id)}</div>
                <div className="text-[0.8125rem] text-muted-foreground">
                  Dashboard user {userName(b.dashboard_user)} · created <TimeAgo iso={b.created_at} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <StatusDot
                  tone={b.active ? "success" : "muted"}
                  label={b.active ? "Active" : "Revoked"}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={open === b.id}
                  onClick={() => setOpen(open === b.id ? null : b.id)}
                >
                  {open === b.id ? <ChevronDown /> : <ChevronRight />} Devices
                </Button>
                {b.active ? (
                  <span className="flex items-center gap-1.5">
                    <HoldAction
                      icon={<UserRoundX />}
                      ariaLabel={`Revoke mapping for ${personName(b.person_id)}`}
                      doneLabel="Revoked"
                      disabled={revoke.isPending}
                      onHold={() => revoke.mutate(b.id)}
                    >
                      Hold to revoke
                    </HoldAction>
                    <HelpTip label="About revoking">
                      Revoking invalidates this person’s enrolled devices, setup grants and
                      verified sessions. They would need to be mapped and enroll again.
                    </HelpTip>
                  </span>
                ) : null}
              </div>
            </div>
            {open === b.id ? (
              <DeviceAuthorizations household={household} binding={b.id} active={b.active} />
            ) : null}
          </div>
        ))
      )}
      {revoke.isError ? (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {errorText(revoke.error)}
        </p>
      ) : null}
    </SettingsSection>
  );
}
