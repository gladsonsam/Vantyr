import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Agent, AgentGroup } from "@/api/types";

interface MembersModalProps {
  visible: boolean;
  onDismiss: () => void;
  group: AgentGroup | null;
  memberIds: string[];
  agentsList: Agent[];
  agentOptions: { label: string; value: string }[];
  /** Kept for compatibility; layout is responsive and ignores it. */
  isNarrow?: boolean;
  onAddMembers: (agentIds: string[]) => Promise<void>;
  onRemoveMember: (agentId: string) => Promise<void>;
}

export function MembersModal({
  visible,
  onDismiss,
  group,
  memberIds,
  agentsList,
  agentOptions,
  onAddMembers,
  onRemoveMember,
}: MembersModalProps) {
  const [addAgentId, setAddAgentId] = useState("");
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) {
      setAddAgentId("");
      setSelectedToAdd([]);
    }
  }, [visible]);

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agentsList) m[a.id] = a;
    return m;
  }, [agentsList]);

  const addableAgents = useMemo(() => {
    const set = new Set(memberIds);
    return agentOptions.filter((o) => !set.has(o.value));
  }, [memberIds, agentOptions]);

  // Drop selections for agents that are no longer addable (e.g. just added).
  const selectableIds = useMemo(() => {
    const allowed = new Set(addableAgents.map((o) => o.value));
    return selectedToAdd.filter((id) => allowed.has(id));
  }, [selectedToAdd, addableAgents]);

  const toggleSelectable = (id: string) => {
    setSelectedToAdd((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleAddSingle = async () => {
    if (!addAgentId) return;
    setLoading(true);
    try {
      await onAddMembers([addAgentId]);
      setAddAgentId("");
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  const handleAddMultiple = async () => {
    if (selectableIds.length === 0) return;
    setLoading(true);
    try {
      await onAddMembers(selectableIds);
      setSelectedToAdd([]);
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (agentId: string) => {
    setLoading(true);
    try {
      await onRemoveMember(agentId);
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  const allSelectableChecked =
    addableAgents.length > 0 && selectableIds.length === addableAgents.length;
  const someSelectableChecked = selectableIds.length > 0 && !allSelectableChecked;

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? `Members: ${group.name}` : "Members"}</DialogTitle>
          <DialogDescription>
            {memberIds.length === 0
              ? "No members in this group yet."
              : `${memberIds.length} member${memberIds.length === 1 ? "" : "s"} in this group.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="members-add-agent">Add agent</FieldLabel>
            <div className="flex gap-2">
              <Select value={addAgentId} onValueChange={(v) => { if (v !== null) setAddAgentId(v); }} disabled={loading}>
                <SelectTrigger id="members-add-agent" className="min-w-0 flex-1">
                  <SelectValue placeholder="Choose an agent" />
                </SelectTrigger>
                <SelectContent>
                  {addableAgents.length === 0 ? (
                    <div className="px-1.5 py-1 text-xs text-muted-foreground">
                      No agents available to add
                    </div>
                  ) : (
                    addableAgents.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <Button
                className="h-9 shrink-0"
                disabled={!addAgentId || loading}
                onClick={() => void handleAddSingle()}
              >
                {loading ? <Spinner /> : null} Add
              </Button>
            </div>
          </Field>

          {addableAgents.length > 0 && (
            <div className="grid gap-2">
              <div className="text-sm font-medium">Add several agents</div>
              <div className="overflow-hidden rounded-xl bg-muted/50">
                <Table>
                  <TableHeader className="[&_tr]:border-foreground/[0.06]">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-10 pl-4!">
                        <Checkbox
                          aria-label="Select all addable agents"
                          checked={allSelectableChecked}
                          indeterminate={someSelectableChecked}
                          disabled={loading}
                          onCheckedChange={(checked) =>
                            setSelectedToAdd(
                              checked ? addableAgents.map((o) => o.value) : [],
                            )
                          }
                        />
                      </TableHead>
                      <TableHead>Agent</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {addableAgents.map((o) => (
                      <TableRow key={o.value}>
                        <TableCell className="pl-4!" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            aria-label={`Add ${o.label}`}
                            checked={selectableIds.includes(o.value)}
                            disabled={loading}
                            onCheckedChange={() => toggleSelectable(o.value)}
                          />
                        </TableCell>
                        <TableCell>{o.label}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div>
                <Button
                  variant="outline"
                  disabled={selectableIds.length === 0 || loading}
                  onClick={() => void handleAddMultiple()}
                >
                  Add selected ({selectableIds.length})
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <div className="text-sm font-medium">Current members</div>
            {memberIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members in this group.</p>
            ) : (
              <div className="overflow-hidden rounded-xl bg-muted/50">
                <Table>
                  <TableBody>
                    {memberIds.map((id) => (
                      <TableRow key={id}>
                        <TableCell className="pl-4!">
                          {agentsById[id]?.name ?? id}
                        </TableCell>
                        <TableCell className="pr-4! text-right">
                          <Button
                            variant="link"
                            size="sm"
                            disabled={loading}
                            aria-label={`Remove ${agentsById[id]?.name ?? id} from group`}
                            onClick={() => void handleRemove(id)}
                          >
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
