import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, RefreshCw, SearchX, X } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@vantyr/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
import { cn } from "@/lib/utils";
import { api } from "@/api";
import { agentQueries } from "@/api/queries/agents";
import { groupKeys, groupQueries } from "@/api/queries/groups";
import { ruleKeys } from "@/api/queries/rules";
import type {
  Agent,
  AgentGroup,
  AlertRule,
  AlertRuleScope,
  AlertRuleScopeKind,
} from "@/api/types";

import { PageActions } from "@/app/shell/AppShell";
import { GroupModal } from "./GroupModal";
import { MembersModal } from "./MembersModal";
import { RuleModal } from "./RuleModal";
import type { GroupRuleValues } from "./groupSchemas";

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

const NO_GROUPS: AgentGroup[] = [];
const NO_AGENTS: Agent[] = [];
const NO_MEMBER_IDS: string[] = [];

/** The page's error text: the error's message, else the raw value. */
function messageOf(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

export function GroupsPage() {
  const queryClient = useQueryClient();
  const groupsQuery = useQuery(groupQueries.list());
  const agentsQuery = useQuery(agentQueries.overview());
  const loading = groupsQuery.isFetching || agentsQuery.isFetching;
  // Validation, mutation and members-load failures; list load failures come from the queries.
  const [localError, setLocalError] = useState<string | null>(null);
  // Query errors from before this moment were dismissed (or cleared by a later action).
  const [errorsClearedAt, setErrorsClearedAt] = useState(0);

  // Group Modals State
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<AgentGroup | null>(null);

  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [membersGroup, setMembersGroup] = useState<AgentGroup | null>(null);
  const membersQuery = useQuery({
    ...groupQueries.members(membersGroup?.id ?? ""),
    enabled: membersModalOpen && membersGroup !== null,
    // openMembers fetches the list right before opening; membership changes invalidate it.
    staleTime: Infinity,
  });
  const membersIds = membersQuery.data?.agent_ids ?? NO_MEMBER_IDS;

  // New alert rule for a group
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [ruleFormPreFill, setRuleFormPreFill] = useState<AlertRule | null>(null);

  const [deleteGroup, setDeleteGroup] = useState<AgentGroup | null>(null);

  // A failed load (of either list) empties the table, as the combined loader did.
  const groupItems =
    groupsQuery.isError || agentsQuery.isError ? NO_GROUPS : groupsQuery.data?.groups ?? NO_GROUPS;
  const agentsList = agentsQuery.data?.agents ?? NO_AGENTS;

  const failedQuery = [groupsQuery, agentsQuery, membersQuery].find(
    (q) => q.isError && !q.isFetching && q.errorUpdatedAt > errorsClearedAt,
  );
  const error = localError ?? (failedQuery ? messageOf(failedQuery.error) : null);

  const clearErrors = () => {
    setLocalError(null);
    // Dismiss the failures on screen: stamping the newest reported error keeps
    // them hidden, while a later failure carries a newer stamp and reappears.
    setErrorsClearedAt(
      Math.max(groupsQuery.errorUpdatedAt ?? 0, agentsQuery.errorUpdatedAt ?? 0, membersQuery.errorUpdatedAt ?? 0),
    );
  };

  const refresh = () => {
    clearErrors();
    void Promise.all([groupsQuery.refetch(), agentsQuery.refetch()]);
  };

  const invalidateGroups = () => queryClient.invalidateQueries({ queryKey: groupKeys.all });

  const saveGroup = useMutation({
    mutationFn: async ({ id, data }: { id: string | null; data: { name: string; description: string } }) => {
      if (id) await api.agentGroupsUpdate(id, data);
      else await api.agentGroupsCreate(data);
    },
    onSuccess: () => invalidateGroups(),
  });

  const addMembers = useMutation({
    mutationFn: ({ groupId, agentIds }: { groupId: string; agentIds: string[] }) =>
      api.agentGroupMembersAdd(groupId, { agent_ids: agentIds }),
    onSuccess: () => invalidateGroups(),
  });

  const removeMember = useMutation({
    mutationFn: ({ groupId, agentId }: { groupId: string; agentId: string }) =>
      api.agentGroupMemberRemove(groupId, agentId),
    onSuccess: () => invalidateGroups(),
  });

  const removeGroup = useMutation({
    mutationFn: (groupId: string) => api.agentGroupsDelete(groupId),
    onSuccess: (_data, groupId) => {
      setDeleteGroup(null);
      setMembersModalOpen(false);
      queryClient.removeQueries({ queryKey: groupKeys.members(groupId) });
      return invalidateGroups();
    },
  });

  const createRule = useMutation({
    mutationFn: (body: Parameters<typeof api.alertRulesCreate>[0]) => api.alertRulesCreate(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ruleKeys.alertRules() }),
  });

  const agentOptions = useMemo(
    () =>
      [...agentsList]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((a) => ({ label: `${a.name} (${a.id.slice(0, 8)}…)`, value: a.id })),
    [agentsList],
  );

  const groupOptions = useMemo(
    () => groupItems.map((g) => ({ label: g.name, value: g.id })),
    [groupItems],
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
    clearErrors();
    try {
      await saveGroup.mutateAsync({ id: activeGroup?.id ?? null, data });
    } catch (e: unknown) {
      setLocalError(messageOf(e));
      throw e;
    }
  };

  const openMembers = async (g: AgentGroup) => {
    clearErrors();
    try {
      await queryClient.fetchQuery(groupQueries.members(g.id));
      setMembersGroup(g);
      setMembersModalOpen(true);
    } catch (e: unknown) {
      setLocalError(messageOf(e));
    }
  };

  const handleAddMembers = async (agentIds: string[]) => {
    if (!membersGroup) return;
    clearErrors();
    try {
      await addMembers.mutateAsync({ groupId: membersGroup.id, agentIds });
    } catch (e: unknown) {
      setLocalError(messageOf(e));
      throw e;
    }
  };

  const handleRemoveMember = async (agentId: string) => {
    if (!membersGroup) return;
    clearErrors();
    try {
      await removeMember.mutateAsync({ groupId: membersGroup.id, agentId });
    } catch (e: unknown) {
      setLocalError(messageOf(e));
      throw e;
    }
  };

  const confirmDeleteGroup = async () => {
    if (!deleteGroup) return;
    clearErrors();
    try {
      await removeGroup.mutateAsync(deleteGroup.id);
    } catch (e: unknown) {
      setLocalError(messageOf(e));
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

  const handleSaveRule = async (data: GroupRuleValues) => {
    const scopes = formScopesToApi(data.scopes);
    clearErrors();
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
      await createRule.mutateAsync(body);
    } catch (e: unknown) {
      setLocalError(messageOf(e));
      throw e;
    }
  };

  const onGroupAction = (g: AgentGroup, id: string) => {
    if (id === "members") void openMembers(g);
    else if (id === "rule") openCreateRuleForGroup(g.id, g.name);
    else if (id === "rename") openEditGroup(g);
    else if (id === "delete") setDeleteGroup(g);
  };

  const groupsPanel = (
    <div className="flex flex-col gap-4">
      <PageActions>
        <Button variant="outline" disabled={loading} onClick={refresh}>
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
              onClick={clearErrors}
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
