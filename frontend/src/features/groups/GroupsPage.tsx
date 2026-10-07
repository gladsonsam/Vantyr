import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Plus, RefreshCw, SearchX, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api } from "@/api";
import type {
  Agent,
  AgentGroup,
  AlertRule,
  AlertRuleChannel,
  AlertRuleMatchMode,
  AlertRuleScope,
  AlertRuleScopeKind,
} from "@/api/types";

import { PageActions } from "@/app/shell/AppShell";
import { GroupModal } from "./GroupModal";
import { MembersModal } from "./MembersModal";
import { RuleModal } from "./RuleModal";

type ScopeFormRow = {
  kind: AlertRuleScopeKind;
  group_id: string;
  agent_id: string;
};

function formScopesToApi(rows: ScopeFormRow[]): AlertRuleScope[] {
  return rows.map((r) => {
    if (r.kind === "all") return { kind: "all" };
    if (r.kind === "group") return { kind: "group", group_id: r.group_id };
    return { kind: "agent", agent_id: r.agent_id };
  });
}

// ─── Row action menus ─────────────────────────────────────────────────────────

function GroupRowMenu({ group, onAction }: { group: AgentGroup; onAction: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Manage ${group.name}`} />}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => onAction("members")}>Manage members</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("rule")}>
          New alert rule for group
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("rename")}>
          Edit name &amp; description
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => onAction("delete")}>
          Delete group
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function GroupsPage() {
  const [groups, setGroups] = useState<AgentGroup[] | null>(null);
  const [agentsList, setAgentsList] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group Modals State
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<AgentGroup | null>(null);

  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [membersGroup, setMembersGroup] = useState<AgentGroup | null>(null);
  const [membersIds, setMembersIds] = useState<string[]>([]);

  // New alert rule for a group
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [ruleFormPreFill, setRuleFormPreFill] = useState<AlertRule | null>(null);

  const [deleteGroup, setDeleteGroup] = useState<AgentGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [g, a] = await Promise.all([api.agentGroupsList(), api.agentsOverview()]);
      setGroups(g.groups);
      setAgentsList(a.agents);
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      setGroups(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agentOptions = useMemo(
    () =>
      [...agentsList]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((a) => ({ label: `${a.name} (${a.id.slice(0, 8)}…)`, value: a.id })),
    [agentsList],
  );

  const groupOptions = useMemo(
    () => groups?.map((g) => ({ label: g.name, value: g.id })) ?? [],
    [groups],
  );

  const openCreateGroup = () => {
    setActiveGroup(null);
    setGroupModalOpen(true);
  };

  const openEditGroup = (g: AgentGroup) => {
    setActiveGroup(g);
    setGroupModalOpen(true);
  };

  const handleSaveGroup = async (data: { name: string; description: string }) => {
    setError(null);
    try {
      if (!activeGroup) {
        await api.agentGroupsCreate(data);
      } else {
        await api.agentGroupsUpdate(activeGroup.id, data);
      }
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      throw e;
    }
  };

  const openMembers = async (g: AgentGroup) => {
    setError(null);
    try {
      const { agent_ids } = await api.agentGroupMembers(g.id);
      setMembersGroup(g);
      setMembersIds(agent_ids);
      setMembersModalOpen(true);
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const handleAddMembers = async (agentIds: string[]) => {
    if (!membersGroup) return;
    setError(null);
    try {
      await api.agentGroupMembersAdd(membersGroup.id, { agent_ids: agentIds });
      const { agent_ids } = await api.agentGroupMembers(membersGroup.id);
      setMembersIds(agent_ids);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      throw e;
    }
  };

  const handleRemoveMember = async (agentId: string) => {
    if (!membersGroup) return;
    setError(null);
    try {
      await api.agentGroupMemberRemove(membersGroup.id, agentId);
      const { agent_ids } = await api.agentGroupMembers(membersGroup.id);
      setMembersIds(agent_ids);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      throw e;
    }
  };

  const confirmDeleteGroup = async () => {
    if (!deleteGroup) return;
    setError(null);
    try {
      await api.agentGroupsDelete(deleteGroup.id);
      setDeleteGroup(null);
      setMembersModalOpen(false);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const openCreateRuleForGroup = (groupId: string, groupName: string) => {
    setRuleFormPreFill({
      id: 0,
      name: groupName ? `${groupName} — ` : "",
      channel: "url",
      pattern: "",
      match_mode: "substring",
      case_insensitive: true,
      cooldown_secs: 300,
      enabled: true,
      take_screenshot: false,
      scopes: [{ kind: "group", group_id: groupId, agent_id: "" }],
    });
    setRuleModalOpen(true);
  };

  const handleSaveRule = async (data: {
    name: string;
    channel: AlertRuleChannel;
    pattern: string;
    match_mode: AlertRuleMatchMode;
    case_insensitive: boolean;
    cooldown_secs: number;
    enabled: boolean;
    take_screenshot: boolean;
    scopes: ScopeFormRow[];
  }) => {
    for (const row of data.scopes) {
      if (row.kind === "group" && !row.group_id.trim()) {
        setError("Each group scope must select a group");
        return;
      }
      if (row.kind === "agent" && !row.agent_id.trim()) {
        setError("Each agent scope must select an agent");
        return;
      }
    }
    const scopes = formScopesToApi(data.scopes);
    setError(null);
    try {
      const body = {
        name: data.name,
        channel: data.channel,
        pattern: data.pattern,
        match_mode: data.match_mode,
        case_insensitive: data.case_insensitive,
        cooldown_secs: data.cooldown_secs,
        enabled: data.enabled,
        take_screenshot: data.take_screenshot,
        scopes: scopes.map((s) => ({
          kind: s.kind,
          group_id: s.group_id,
          agent_id: s.agent_id,
        })),
      };
      await api.alertRulesCreate(body);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      throw e;
    }
  };

  const onGroupAction = (g: AgentGroup, id: string) => {
    if (id === "members") void openMembers(g);
    else if (id === "rule") openCreateRuleForGroup(g.id, g.name);
    else if (id === "rename") openEditGroup(g);
    else if (id === "delete") setDeleteGroup(g);
  };

  const groupItems = groups ?? [];

  const groupsPanel = (
    <div className="flex flex-col gap-4">
      <PageActions>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
        </Button>
        <Button onClick={openCreateGroup}>
          <Plus /> Create group
        </Button>
      </PageActions>

      {loading && groupItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading groups…</p>
      ) : groupItems.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>No groups yet</EmptyTitle>
            <EmptyDescription>Create a group to target many computers with the same rules.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl bg-card md:block">
            <Table>
              <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5!">Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead className="w-14 pr-5! text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-3">
                {groupItems.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="pl-5!">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() => void openMembers(g)}
                      >
                        {g.name}
                      </Button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{g.description || "—"}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">
                      {g.member_count}
                    </TableCell>
                    <TableCell className="pr-5! text-right">
                      <GroupRowMenu group={g} onAction={(id) => onGroupAction(g, id)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="grid gap-4 md:hidden">
            {groupItems.map((g) => (
              <div key={g.id} className="flex flex-col gap-2 rounded-xl bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <Button
                    variant="link"
                    className="h-9 min-w-0 flex-1 justify-start truncate p-0 text-left text-base"
                    onClick={() => void openMembers(g)}
                  >
                    {g.name}
                  </Button>
                  <GroupRowMenu group={g} onAction={(id) => onGroupAction(g, id)} />
                </div>
                <p className="text-sm text-muted-foreground">{g.description || "—"}</p>
                <p className="font-mono text-xs text-muted-foreground tabular-nums">
                  {g.member_count} member{g.member_count === 1 ? "" : "s"}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-start justify-between gap-2">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {groupsPanel}

      <GroupModal
        visible={groupModalOpen}
        onDismiss={() => {
          setGroupModalOpen(false);
          setActiveGroup(null);
        }}
        group={activeGroup}
        onSave={handleSaveGroup}
      />

      <MembersModal
        visible={membersModalOpen}
        onDismiss={() => {
          setMembersModalOpen(false);
          setMembersGroup(null);
        }}
        group={membersGroup}
        memberIds={membersIds}
        agentsList={agentsList}
        agentOptions={agentOptions}
        onAddMembers={handleAddMembers}
        onRemoveMember={handleRemoveMember}
      />

      <RuleModal
        visible={ruleModalOpen}
        onDismiss={() => {
          setRuleModalOpen(false);
          setRuleFormPreFill(null);
        }}
        rule={ruleFormPreFill}
        agentOptions={agentOptions}
        groupOptions={groupOptions}
        onSave={handleSaveRule}
      />

      <AlertDialog open={deleteGroup !== null} onOpenChange={(open) => !open && setDeleteGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{deleteGroup?.name}&quot;? Alert rule scopes referencing this group will
              be removed (cascade).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDeleteGroup()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


    </div>
  );
}
