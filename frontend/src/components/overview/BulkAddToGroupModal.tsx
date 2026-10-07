import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/api";
import type { AgentGroup } from "@/api/types";

export function BulkAddToGroupModal({
  agentIds,
  onDismiss,
}: {
  agentIds: string[];
  onDismiss: () => void;
}) {
  const [groups, setGroups] = useState<AgentGroup[] | null>(null);
  const [groupId, setGroupId] = useState<string>("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  useEffect(() => {
    let c = false;
    setLoadErr(null);
    api
      .agentGroupsList()
      .then((r) => {
        if (!c) setGroups(r.groups);
      })
      .catch((e) => {
        if (!c) setLoadErr(String(e));
      });
    return () => {
      c = true;
    };
  }, []);

  const options = useMemo(
    () => (groups ?? []).map((g) => ({ label: g.name, value: g.id })),
    [groups],
  );

  const submit = async () => {
    if (!groupId || agentIds.length === 0) return;
    setActionErr(null);
    setBusy(true);
    try {
      await api.agentGroupMembersAdd(groupId, { agent_ids: agentIds });
      onDismiss();
    } catch (e: unknown) {
      setActionErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
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
          <Button disabled={!groupId || busy || agentIds.length === 0} onClick={() => void submit()}>
            {busy && <Spinner />} Add to group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
