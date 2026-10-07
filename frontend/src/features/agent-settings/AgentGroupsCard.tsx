import { useMemo, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { groupKeys, groupQueries } from "@/api/queries/groups";
import type { AgentGroup } from "@/api/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const NO_GROUPS: AgentGroup[] = [];

type MembershipChange = { action: "add" | "remove"; groupId: string };

/** The groups this agent belongs to (it inherits their alert rules); admins add and remove it. */
export function AgentGroupsCard({ agentId, onOpenAgentGroups }: { agentId: string; onOpenAgentGroups?: () => void }) {
  const queryClient = useQueryClient();
  const [memberGroupsQuery, allGroupsQuery] = useQueries({
    queries: [groupQueries.forAgent(agentId), groupQueries.list()],
  });
  const groupsFailure = memberGroupsQuery.error ?? allGroupsQuery.error;
  const memberGroups = !groupsFailure ? memberGroupsQuery.data?.groups ?? null : null;
  const allGroups = allGroupsQuery.data?.groups ?? NO_GROUPS;
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
  const ok = change.isSuccess ? (change.variables.action === "add" ? "Added to group." : "Removed from group.") : null;

  const addableGroupOptions = useMemo(() => {
    const inSet = new Set((memberGroups ?? []).map((g) => g.id));
    return [...allGroups]
      .filter((g) => !inSet.has(g.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ label: g.name, value: g.id }));
  }, [allGroups, memberGroups]);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Agent groups</CardTitle>
        <CardDescription>Inherits alert rules from these groups.</CardDescription>
        {onOpenAgentGroups && (
          <CardAction>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenAgentGroups()}>
              Manage groups
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{String(error)}</AlertDescription>
          </Alert>
        )}
        {ok && (
          <Alert>
            <AlertDescription className="text-success">{ok}</AlertDescription>
          </Alert>
        )}
        {loading && memberGroups === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner /> Loading groups…
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3">Group</TableHead>
                  <TableHead className="px-3">Description</TableHead>
                  <TableHead className="w-25 px-3"><span className="sr-only">Remove</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(memberGroups ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      Not in any group.
                    </TableCell>
                  </TableRow>
                ) : (
                  (memberGroups ?? []).map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="px-3 py-3.5 font-medium">{g.name}</TableCell>
                      <TableCell className="px-3 py-3.5">{g.description?.trim() || "—"}</TableCell>
                      <TableCell className="px-3 py-3.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => change.mutate({ action: "remove", groupId: g.id })}
                        >
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <Field>
              <FieldLabel htmlFor="add-to-group">Add to group</FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  value={addGroupPick}
                  onValueChange={(value) => setAddGroupPick(value ?? "")}
                  disabled={busy || addableGroupOptions.length === 0}
                >
                  <SelectTrigger id="add-to-group" className="h-9 w-full sm:max-w-xs">
                    <SelectValue placeholder="Choose a group" />
                  </SelectTrigger>
                  <SelectContent>
                    {addableGroupOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  disabled={!addGroupPick || busy}
                  onClick={() => {
                    if (addGroupPick) change.mutate({ action: "add", groupId: addGroupPick });
                  }}
                >
                  Add
                </Button>
              </div>
              {addableGroupOptions.length === 0 && <FieldDescription>No other groups.</FieldDescription>}
            </Field>
          </>
        )}
      </CardContent>
    </Card>
  );
}
