import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { groupKeys, groupQueries } from "@/api/queries/groups";
import type { AgentGroup, AgentGroupMembership } from "@/api/types";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Field, FieldLabel } from "@vantyr/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { HelpTip } from "@/components/common/HelpTip";

const NO_GROUPS: AgentGroup[] = [];
const NO_MEMBERS: AgentGroupMembership[] = [];

type MembershipChange = { action: "add" | "remove"; groupId: string };

/** The groups this agent belongs to (it inherits their alert rules); admins add and remove it. */
export function AgentGroupsCard({ agentId, onOpenAgentGroups }: { agentId: string; onOpenAgentGroups?: () => void }) {
  const queryClient = useQueryClient();
  const [memberGroupsQuery, allGroupsQuery] = useQueries({
    queries: [groupQueries.forAgent(agentId), groupQueries.list()],
  });
  const groupsFailure = memberGroupsQuery.error ?? allGroupsQuery.error;
  const memberGroups = usableMembership(memberGroupsQuery.data?.groups, groupsFailure);
  const allGroups = allGroupsQuery.data?.groups ?? NO_GROUPS;
  const memberRows = memberGroups ?? NO_MEMBERS;
  const loading = memberGroupsQuery.isFetching || allGroupsQuery.isFetching;
  const [addGroupPick, setAddGroupPick] = useState<string>("");

  const change = useMutation({
    mutationFn: async ({ action, groupId }: MembershipChange) => {
      if (action === "add") await api.agentGroupMembersAdd(groupId, { agent_ids: [agentId] });
      else await api.agentGroupMemberRemove(groupId, agentId);
    },
    onSuccess: (_res, { action }) => {
      if (action === "add") setAddGroupPick("");
      // Membership changes also move the member counts shown on the Groups page.
      void queryClient.invalidateQueries({ queryKey: groupKeys.all });
    },
  });
  const busy = change.isPending;
  const error = change.error ?? groupsFailure;
  const ok = membershipSuccess(change.isSuccess, change.variables);
  // A removed row takes its button with it, so focus moves to the outcome instead of falling back to the page.
  const statusRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (ok) statusRef.current?.focus(); }, [ok]);

  const addableGroupOptions = useMemo(() => {
    const inSet = new Set(memberRows.map((g) => g.id));
    return [...allGroups]
      .filter((g) => !inSet.has(g.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ label: g.name, value: g.id }));
  }, [allGroups, memberRows]);

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-5 p-5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-1.5 text-base font-medium">
            {membershipTitle(memberGroups === null ? null : memberRows.length)}
            <HelpTip>This device inherits alert rules from the groups it is in.</HelpTip>
          </h3>
          {onOpenAgentGroups && (
            <Button variant="outline" size="sm" className="pointer-coarse:h-9" disabled={busy} onClick={() => onOpenAgentGroups()}>
              Manage groups
            </Button>
          )}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{String(error)}</AlertDescription>
          </Alert>
        )}
        {ok && <p ref={statusRef} tabIndex={-1} role="status" className="text-success outline-none">{ok}</p>}
        {loading && memberGroups === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Spinner /> Loading groups…
          </div>
        ) : (
          <>
            <MemberList rows={memberRows} busy={busy} onRemove={(groupId) => change.mutate({ action: "remove", groupId })} />
            <AddToGroup
              options={addableGroupOptions}
              pick={addGroupPick}
              onPick={setAddGroupPick}
              busy={busy}
              adding={busy && change.variables?.action === "add"}
              onAdd={(groupId) => change.mutate({ action: "add", groupId })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function membershipSuccess(success: boolean, change: MembershipChange | undefined) {
  if (!success || !change) return null;
  return change.action === "add" ? "Added to group." : "Removed from group.";
}

function usableMembership<T>(rows: T[] | undefined, failure: unknown): T[] | null {
  return failure ? null : rows ?? null;
}

function membershipTitle(count: number | null) {
  if (count === null) return "Groups";
  if (count === 0) return "Not in any group";
  return `In ${count} ${count === 1 ? "group" : "groups"}`;
}

function MemberList({ rows, busy, onRemove }: { rows: AgentGroupMembership[]; busy: boolean; onRemove: (groupId: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <ul aria-label="Groups this device is in" className="overflow-hidden rounded-lg border border-foreground/[0.08]">
      {rows.map((g) => (
        <li key={g.id} className="flex min-h-11 items-center gap-3 border-b border-foreground/[0.06] px-3 py-2 last:border-b-0">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{g.name}</p>
            {g.description?.trim() && <p className="truncate text-xs text-muted-foreground">{g.description.trim()}</p>}
          </div>
          <Button variant="ghost" size="sm" className="pointer-coarse:h-9" aria-label={`Remove from ${g.name}`} disabled={busy} onClick={() => onRemove(g.id)}>
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

function AddToGroup({ options, pick, onPick, busy, adding, onAdd }: {
  options: { label: string; value: string }[]; pick: string; onPick: (groupId: string) => void;
  busy: boolean; adding: boolean; onAdd: (groupId: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="add-to-group">Add to a group</FieldLabel>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={pick} onValueChange={(value) => onPick(value ?? "")} disabled={busy || options.length === 0}>
          <SelectTrigger id="add-to-group" className="h-9 w-full sm:max-w-xs">
            <SelectValue placeholder={options.length === 0 ? "No other groups" : "Choose a group"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" disabled={!pick || busy} onClick={() => { if (pick) onAdd(pick); }}>
          <span>Add</span>{adding && <Spinner />}
        </Button>
      </div>
    </Field>
  );
}
