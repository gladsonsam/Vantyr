import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Field, FieldLabel } from "@vantyr/ui/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api } from "@/api";
import { groupKeys, groupQueries } from "@/api/queries/groups";

export function BulkAddToGroupModal({
  agentIds,
  onDismiss,
}: {
  agentIds: string[];
  onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const groupsQuery = useQuery(groupQueries.list());
  const groups = groupsQuery.data?.groups ?? null;
  const loadErr = groupsQuery.error ? String(groupsQuery.error) : null;
  const [groupId, setGroupId] = useState<string>("");
  const addToGroup = useMutation({
    mutationFn: (targetGroupId: string) => api.agentGroupMembersAdd(targetGroupId, { agent_ids: agentIds }),
    onSuccess: () => {
      onDismiss();
      void queryClient.invalidateQueries({ queryKey: groupKeys.all });
    },
  });
  const busy = addToGroup.isPending;
  const actionErr = addToGroup.error ? String((addToGroup.error as Error)?.message ?? addToGroup.error) : null;

  const options = useMemo(
    () => (groups ?? []).map((g) => ({ label: g.name, value: g.id })),
    [groups],
  );

  const submit = () => {
    if (!groupId || agentIds.length === 0) return;
    addToGroup.mutate(groupId);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add selected agents to group</DialogTitle>
          <DialogDescription>
            {agentIds.length} agent{agentIds.length === 1 ? "" : "s"} will be added (existing memberships are kept).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {loadErr && (
            <Alert variant="destructive">
              <AlertDescription>{loadErr}</AlertDescription>
            </Alert>
          )}
          {actionErr && (
            <Alert variant="destructive">
              <AlertDescription>{actionErr}</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel htmlFor="bulk-group">Group</FieldLabel>
            <Select value={groupId} onValueChange={(next) => setGroupId(typeof next === "string" ? next : "")} disabled={groups === null || options.length === 0}>
              <SelectTrigger id="bulk-group" className="w-full">
                <SelectValue placeholder="Choose a group" />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {groups !== null && options.length === 0 && (
              <p className="text-sm text-muted-foreground">No groups yet — open Agent groups from the overview or the Groups page to create one.</p>
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Cancel
          </Button>
          <Button disabled={!groupId || busy || agentIds.length === 0} onClick={submit}>
            {busy && <Spinner />} Add to group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
