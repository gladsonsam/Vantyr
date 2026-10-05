import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ExternalLink, MoreHorizontal, Plus, RefreshCw, SearchX, X } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api, apiUrl } from "@/lib/api";
import type {
  Agent,
  AgentGroup,
  AlertRule,
  AlertRuleChannel,
  AlertRuleMatchMode,
  AlertRuleScope,
  AlertRuleScopeKind,
} from "@/lib/types";

import { PageActions } from "@/components/fleet/AppShell";
import { GroupModal } from "@/components/groups/GroupModal";
import { MembersModal } from "@/components/groups/MembersModal";
import { RuleModal } from "@/components/groups/RuleModal";
import { HistoryTable, type AlertRuleHistoryEventRow } from "@/components/groups/HistoryTable";

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

function formatScopesLabel(
  scopes: AlertRuleScope[],
  groups: AgentGroup[],
  agentsById: Record<string, Agent>,
): string {
  return scopes
    .map((s) => {
      if (s.kind === "all") return "All agents";
      if (s.kind === "group") {
        const g = groups.find((x) => x.id === s.group_id);
        return `Group: ${g?.name ?? s.group_id ?? "?"}`;
      }
      const a = s.agent_id ? agentsById[s.agent_id] : undefined;
      return `Agent: ${a?.name ?? s.agent_id ?? "?"}`;
    })
    .join(" · ");
}

type AlertsTabId = "rules" | "history";

// ─── Screenshot Preview Modal ─────────────────────────────────────────────────

function ScreenshotPreviewModal({
  eventId,
  visible,
  onClose,
}: {
  eventId: number | null;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Screenshot</DialogTitle>
        </DialogHeader>
        {eventId != null ? (
          <div className="flex justify-center">
            <img
              src={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
              alt="Alert screenshot"
              className="max-h-[70vh] max-w-full rounded-lg object-contain"
            />
          </div>
        ) : null}
        <DialogFooter>
          {eventId != null && (
            <Button
              variant="outline"
              render={<a href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)} target="_blank" rel="noreferrer" />}
            >
              <ExternalLink /> Open in new tab
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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

function RuleRowMenu({ rule, onAction }: { rule: AlertRule; onAction: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Manage ${rule.name || `rule ${rule.id}`}`}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => onAction("history")}>Trigger history</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("edit")}>Edit</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => onAction("delete")}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function parseAlertsTab(v: string | null): AlertsTabId {
  return v === "history" ? "history" : "rules";
}

export function NotificationsAdminPage({ mode }: { mode: "groups" | "alerts" }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const alertsTab = mode === "alerts" ? parseAlertsTab(searchParams.get("tab")) : "rules";

  const setAlertsTab = useCallback(
    (id: AlertsTabId) => {
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.set("tab", id);
          return n;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (mode !== "alerts") return;
    const t = searchParams.get("tab");
    if (t !== "rules" && t !== "history") {
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.set("tab", "rules");
          return n;
        },
        { replace: true },
      );
    }
  }, [mode, searchParams, setSearchParams]);

  const [groups, setGroups] = useState<AgentGroup[] | null>(null);
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [agentsList, setAgentsList] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group Modals State
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<AgentGroup | null>(null);

  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [membersGroup, setMembersGroup] = useState<AgentGroup | null>(null);
  const [membersIds, setMembersIds] = useState<string[]>([]);

  // Rule Modals State
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [activeRule, setActiveRule] = useState<AlertRule | null>(null);
  const [ruleFormPreFill, setRuleFormPreFill] = useState<AlertRule | null>(null);

  const [deleteGroup, setDeleteGroup] = useState<AgentGroup | null>(null);
  const [deleteRule, setDeleteRule] = useState<AlertRule | null>(null);

  // Per-rule history modal
  const [historyRule, setHistoryRule] = useState<AlertRule | null>(null);
  const [historyEvents, setHistoryEvents] = useState<AlertRuleHistoryEventRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Global history (all rules)
  const [globalHistory, setGlobalHistory] = useState<AlertRuleHistoryEventRow[]>([]);
  const [globalHistoryLoading, setGlobalHistoryLoading] = useState(false);

  // Screenshot preview
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);

  const agentsById = useMemo(() => {
    const m: Record<string, Agent> = {};
    for (const a of agentsList) m[a.id] = a;
    return m;
  }, [agentsList]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === "groups") {
        const [g, a] = await Promise.all([api.agentGroupsList(), api.agentsOverview()]);
        setGroups(g.groups);
        setRules(null);
        setAgentsList(a.agents);
      } else {
        const [g, r, a] = await Promise.all([
          api.agentGroupsList(),
          api.alertRulesList(),
          api.agentsOverview(),
        ]);
        setGroups(g.groups);
        setRules(r.rules);
        setAgentsList(a.agents);
      }
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      setGroups(null);
      setRules(null);
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Fetch global history (all rules, all agents) ───────────────────────────
  const fetchGlobalHistory = useCallback(async (ruleList: AlertRule[]) => {
    if (ruleList.length === 0) {
      setGlobalHistory([]);
      return;
    }
    setGlobalHistoryLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        ruleList.map((rule) => api.alertRuleEvents(rule.id, { limit: 200, offset: 0 })),
      );
      const all: AlertRuleHistoryEventRow[] = [];
      results.forEach((res) => {
        if (res.status === "fulfilled") {
          const rows = Array.isArray(res.value.rows) ? res.value.rows : [];
          for (const row of rows) {
            all.push({
              id: Number(row.id ?? 0),
              agent_id: String(row.agent_id ?? ""),
              agent_name: String(row.agent_name ?? ""),
              rule_name: String(row.rule_name ?? ""),
              channel: String(row.channel ?? ""),
              snippet: String(row.snippet ?? ""),
              has_screenshot: Boolean(row.has_screenshot),
              screenshot_requested: Boolean(row.screenshot_requested),
              created_at: String(row.created_at ?? ""),
            });
          }
        }
      });
      // Sort by date desc
      all.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
      setGlobalHistory(all);
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      setGlobalHistory([]);
    } finally {
      setGlobalHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "alerts" && alertsTab === "history" && rules !== null) {
      void fetchGlobalHistory(rules);
    }
  }, [mode, alertsTab, rules, fetchGlobalHistory]);

  // ── Per-rule history ───────────────────────────────────────────────────────
  const fetchRuleHistory = useCallback(async (rule: AlertRule) => {
    setHistoryLoading(true);
    setHistoryEvents([]);
    setError(null);
    try {
      const data = await api.alertRuleEvents(rule.id, { limit: 500, offset: 0 });
      const rows = Array.isArray(data.rows) ? data.rows : [];
      setHistoryEvents(
        rows.map((row) => ({
          id: Number(row.id ?? 0),
          agent_id: String(row.agent_id ?? ""),
          agent_name: String(row.agent_name ?? ""),
          rule_name: String(row.rule_name ?? ""),
          channel: String(row.channel ?? ""),
          snippet: String(row.snippet ?? ""),
          has_screenshot: Boolean(row.has_screenshot),
          screenshot_requested: Boolean(row.screenshot_requested),
          created_at: String(row.created_at ?? ""),
        })),
      );
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      setHistoryEvents([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (historyRule) void fetchRuleHistory(historyRule);
  }, [historyRule, fetchRuleHistory]);

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

  const openCreateRule = () => {
    setActiveRule(null);
    setRuleFormPreFill(null);
    setRuleModalOpen(true);
  };

  const openCreateRuleForGroup = (groupId: string, groupName: string) => {
    setActiveRule(null);
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
    if (mode === "alerts") setAlertsTab("rules");
  };

  const openEditRule = (rule: AlertRule) => {
    setActiveRule(rule);
    setRuleFormPreFill(null);
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
      if (!activeRule) {
        await api.alertRulesCreate(body);
      } else {
        await api.alertRulesUpdate(activeRule.id, body);
      }
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      throw e;
    }
  };

  const confirmDeleteRule = async () => {
    if (!deleteRule) return;
    setError(null);
    try {
      await api.alertRulesDelete(deleteRule.id);
      setDeleteRule(null);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const onGroupAction = (g: AgentGroup, id: string) => {
    if (id === "members") void openMembers(g);
    else if (id === "rule") openCreateRuleForGroup(g.id, g.name);
    else if (id === "rename") openEditGroup(g);
    else if (id === "delete") setDeleteGroup(g);
  };

  const onRuleAction = (r: AlertRule, id: string) => {
    if (id === "history") setHistoryRule(r);
    else if (id === "edit") openEditRule(r);
    else if (id === "delete") setDeleteRule(r);
  };

  const groupItems = groups ?? [];
  const ruleItems = rules ?? [];

  // Navigate to agent timeline and highlight the nearest activity to the alert
  const goToTimeline = (agentId: string, timestamp: string) => {
    const params = new URLSearchParams({ tab: "activity", at: timestamp });
    navigate(`/agents/${agentId}?${params.toString()}`);
  };

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

  const rulesPanel = (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Rules use substring or regex against the active <strong className="text-foreground">URL</strong> or
        batched <strong className="text-foreground">keystroke</strong> text. Use{" "}
        <strong className="text-foreground">cooldown</strong> to avoid spamming the same match. Scopes
        can be combined. Click a rule name or <strong className="text-foreground">Trigger history</strong> to
        see past firings per agent.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="lg" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
        </Button>
        <Button size="lg" onClick={openCreateRule}>
          <Plus /> Create alert rule
        </Button>
      </div>

      {loading && ruleItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading rules…</p>
      ) : ruleItems.length === 0 ? (
        <Empty className="bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>No alert rules yet</EmptyTitle>
            <EmptyDescription>Create a rule to start monitoring URLs or keystrokes.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl bg-card md:block">
            <Table>
              <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5!">Name</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Cooldown (s)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Screenshot</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead className="w-14 pr-5! text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-3">
                {ruleItems.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="pl-5!">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() => setHistoryRule(r)}
                      >
                        {r.name || `Rule #${r.id}`}
                      </Button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.channel}</TableCell>
                    <TableCell className="max-w-56">
                      <span className="block truncate font-mono text-xs" title={r.pattern}>
                        {r.pattern}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.match_mode}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">
                      {r.cooldown_secs}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-[13px] font-medium",
                          r.enabled ? "text-success" : "text-muted-foreground",
                        )}
                      >
                        {r.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-[13px] font-medium",
                          r.take_screenshot ? "text-info" : "text-muted-foreground",
                        )}
                      >
                        {r.take_screenshot ? "On" : "Off"}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-64 text-sm text-muted-foreground">
                      {formatScopesLabel(r.scopes, groups ?? [], agentsById)}
                    </TableCell>
                    <TableCell className="pr-5! text-right">
                      <RuleRowMenu rule={r} onAction={(id) => onRuleAction(r, id)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="grid gap-4 md:hidden">
            {ruleItems.map((r) => (
              <div key={r.id} className="flex flex-col gap-2 rounded-xl bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <Button variant="link" className="h-9 min-w-0 flex-1 justify-start truncate p-0 text-left text-base" onClick={() => setHistoryRule(r)}>
                    {r.name || `Rule #${r.id}`}
                  </Button>
                  <RuleRowMenu rule={r} onAction={(id) => onRuleAction(r, id)} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {r.channel} · {r.match_mode} · cooldown {r.cooldown_secs}s ·{" "}
                  <span className={cn(r.enabled ? "text-success" : "text-muted-foreground")}>
                    {r.enabled ? "Enabled" : "Disabled"}
                  </span>{" "}
                  ·{" "}
                  <span className={cn(r.take_screenshot ? "text-info" : "text-muted-foreground")}>
                    {r.take_screenshot ? "Screenshot on" : "Screenshot off"}
                  </span>
                </p>
                <p className="font-mono text-xs break-all">{r.pattern}</p>
                <p className="text-xs text-muted-foreground">
                  {formatScopesLabel(r.scopes, groups ?? [], agentsById)}
                </p>
                <div>
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-9"
                    onClick={() => setHistoryRule(r)}
                  >
                    Trigger history
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );

  const globalHistoryPanel = (
    <HistoryTable
      loading={globalHistoryLoading}
      events={globalHistory}
      showRuleName={true}
      pageSize={20}
      emptyText="No notifications have fired yet"
      onPreviewScreenshot={(id) => setPreviewEventId(id)}
      onNavigateToAgent={(id) => navigate(`/agents/${id}`)}
      onGoToTimeline={goToTimeline}
      onRefresh={() => rules && void fetchGlobalHistory(rules)}
      title="Notification history"
      description="All fired notifications across every rule and agent, newest first."
    />
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

      {mode === "groups" ? (
        groupsPanel
      ) : (
        <Tabs value={alertsTab} onValueChange={(value) => setAlertsTab(value as AlertsTabId)}>
          <div className="flex items-end gap-4 border-b border-foreground/[0.06]">
            <div className="-mb-px min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <TabsList variant="line" aria-label="Alerts view" className="h-11! gap-2 p-0">
                <TabsTrigger value="rules" className="h-full! flex-none gap-2 px-2.5 after:bottom-0!">
                  Alert rules
                  {ruleItems.length > 0 && (
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {ruleItems.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="history" className="h-full! flex-none gap-2 px-2.5 after:bottom-0!">
                  History
                  {globalHistory.length > 0 && (
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {globalHistory.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>
          </div>
          <TabsContent value="rules">{rulesPanel}</TabsContent>
          <TabsContent value="history">{globalHistoryPanel}</TabsContent>
        </Tabs>
      )}

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
          setActiveRule(null);
          setRuleFormPreFill(null);
        }}
        rule={activeRule ?? ruleFormPreFill}
        agentOptions={agentOptions}
        groupOptions={groupOptions}
        onSave={handleSaveRule}
      />

      <Dialog
        open={historyRule !== null}
        onOpenChange={(open) => {
          if (!open) {
            setHistoryRule(null);
            setHistoryEvents([]);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {historyRule
                ? `Trigger history: ${historyRule.name || `Rule #${historyRule.id}`}`
                : "Trigger history"}
            </DialogTitle>
          </DialogHeader>
          <HistoryTable
            loading={historyLoading}
            events={historyEvents}
            showRuleName={false}
            onPreviewScreenshot={(id) => setPreviewEventId(id)}
            onNavigateToAgent={(id) => navigate(`/agents/${id}`)}
            onGoToTimeline={goToTimeline}
            onRefresh={() => historyRule && void fetchRuleHistory(historyRule)}
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={!historyRule || historyLoading}
              onClick={() => historyRule && void fetchRuleHistory(historyRule)}
            >
              {historyLoading ? <Spinner /> : <RefreshCw />} Refresh
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setHistoryRule(null);
                setHistoryEvents([]);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <AlertDialog open={deleteRule !== null} onOpenChange={(open) => !open && setDeleteRule(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete alert rule?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete rule #{deleteRule?.id}
              {deleteRule?.name ? ` (${deleteRule.name})` : ""}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDeleteRule()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ScreenshotPreviewModal
        eventId={previewEventId}
        visible={previewEventId !== null}
        onClose={() => setPreviewEventId(null)}
      />
    </div>
  );
}
