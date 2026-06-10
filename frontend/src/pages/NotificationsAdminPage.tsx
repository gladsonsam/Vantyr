import { ContentLayout, Header, SpaceBetween, Table, Button, ButtonDropdown, Modal, Box, Alert, Tabs, SegmentedControl, Badge, useCollection } from "../components/ui/console";
import type { ButtonDropdownProps } from "../components/ui/console";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, apiUrl } from "../lib/api";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type {
  Agent,
  AgentGroup,
  AlertRule,
  AlertRuleChannel,
  AlertRuleMatchMode,
  AlertRuleScopeKind,
  AlertRuleScope,
} from "../lib/types";

import { GroupModal } from "../components/groups/GroupModal";
import { MembersModal } from "../components/groups/MembersModal";
import { RuleModal } from "../components/groups/RuleModal";
import { HistoryTable, type AlertRuleHistoryEventRow } from "../components/groups/HistoryTable";

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
    <Modal
      visible={visible}
      onDismiss={onClose}
      header="Screenshot"
      size="max"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            {eventId != null && (
              <Button
                href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
                target="_blank"
                iconName="external"
              >
                Open in new tab
              </Button>
            )}
            <Button variant="link" onClick={onClose}>
              Close
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      {eventId != null ? (
        <div style={{ textAlign: "center" }}>
          <img
            src={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
            alt="Alert screenshot"
            style={{
              maxWidth: "100%",
              maxHeight: "70vh",
              objectFit: "contain",
              borderRadius: 6,
            }}
          />
        </div>
      ) : null}
    </Modal>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function parseAlertsTab(v: string | null): AlertsTabId {
  return v === "history" ? "history" : "rules";
}

export function NotificationsAdminPage({ mode }: { mode: "groups" | "alerts" }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNarrow = useMediaQuery("(max-width: 768px)");

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
        ruleList.map((rule) =>
          api.alertRuleEvents(rule.id, { limit: 200, offset: 0 })
        )
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

  const {
    items: historyDisplayItems,
    collectionProps: historyCollectionProps,
    filterProps: historyFilterProps,
    paginationProps: historyPaginationProps,
  } = useCollection(historyEvents, {
    filtering: {
      empty: "No triggers yet",
      noMatch: "No rows match the filter",
      filteringFunction: (item, filteringText) => {
        const q = filteringText.toLowerCase();
        return (
          item.agent_name.toLowerCase().includes(q) ||
          item.snippet.toLowerCase().includes(q) ||
          item.channel.toLowerCase().includes(q)
        );
      },
    },
    pagination: { pageSize: 15 },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: "created_at" },
        isDescending: true,
      },
    },
  });

  const {
    items: globalDisplayItems,
    collectionProps: globalCollectionProps,
    filterProps: globalFilterProps,
    paginationProps: globalPaginationProps,
  } = useCollection(globalHistory, {
    filtering: {
      empty: "No notifications have fired yet",
      noMatch: "No rows match the filter",
      filteringFunction: (item, filteringText) => {
        const q = filteringText.toLowerCase();
        return (
          item.agent_name.toLowerCase().includes(q) ||
          item.rule_name.toLowerCase().includes(q) ||
          item.snippet.toLowerCase().includes(q) ||
          item.channel.toLowerCase().includes(q)
        );
      },
    },
    pagination: { pageSize: 20 },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: "created_at" },
        isDescending: true,
      },
    },
  });

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

  const groupRowActions = (): ButtonDropdownProps.ItemOrGroup[] => [
    { id: "members", text: "Manage members" },
    { id: "rule", text: "New alert rule for group" },
    { id: "rename", text: "Edit name & description" },
    { id: "delete", text: "Delete group" },
  ];

  const ruleRowActions = (): ButtonDropdownProps.ItemOrGroup[] => [
    { id: "history", text: "Trigger history" },
    { id: "edit", text: "Edit" },
    { id: "delete", text: "Delete" },
  ];

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

  const headerActions = (
    <Button iconName="refresh" onClick={() => void load()} loading={loading}>
      Refresh
    </Button>
  );

  const mobileToolbar = (
    <div className="vantyr-users-toolbar-mobile">
      {headerActions}
      {mode === "groups" ? (
        <Button onClick={openCreateGroup}>Create group</Button>
      ) : alertsTab === "rules" ? (
        <Button variant="primary" onClick={openCreateRule}>
          Create alert rule
        </Button>
      ) : null}
    </div>
  );

  const groupsPanel = (
    <SpaceBetween size="l">
      <Box variant="p" color="text-body-secondary">
        Use groups to target many computers with the same URL or keystroke rules. Click a group name to manage
        members, use <b>New alert rule for group</b> to pre-fill scope, or add several agents at once inside the
        members dialog. You can also assign from each computer&apos;s <b>Settings</b> tab or bulk-add from the
        overview.
      </Box>
      {!isNarrow && <Button onClick={openCreateGroup}>Create group</Button>}
      {isNarrow ? (
        loading && groupItems.length === 0 ? (
          <Box color="text-body-secondary">Loading groups…</Box>
        ) : groupItems.length === 0 ? (
          <Box color="text-body-secondary">No groups yet.</Box>
        ) : (
          <SpaceBetween size="m">
            {groupItems.map((g) => (
              <Box key={g.id} variant="div" className="vantyr-users-mobile-card">
                <SpaceBetween size="s">
                  <Box variant="h3" tagOverride="div" fontSize="heading-m">
                    <Button variant="inline-link" onClick={() => void openMembers(g)}>
                      {g.name}
                    </Button>
                  </Box>
                  <Box color="text-body-secondary">{g.description || "—"}</Box>
                  <Box color="text-body-secondary" fontSize="body-s">
                    {g.member_count} member{g.member_count === 1 ? "" : "s"}
                  </Box>
                  <div className="vantyr-users-manage-slot">
                    <ButtonDropdown
                      variant="primary"
                      items={groupRowActions()}
                      expandToViewport
                      onItemClick={({ detail }) => onGroupAction(g, detail.id)}
                    >
                      Manage
                    </ButtonDropdown>
                  </div>
                </SpaceBetween>
              </Box>
            ))}
          </SpaceBetween>
        )
      ) : (
        <Table
          columnDefinitions={[
            {
              id: "name",
              header: "Name",
              cell: (g) => (
                <Button variant="inline-link" onClick={() => void openMembers(g)}>
                  {g.name}
                </Button>
              ),
            },
            { id: "desc", header: "Description", cell: (g) => g.description || "—" },
            { id: "n", header: "Members", cell: (g) => String(g.member_count) },
            {
              id: "act",
              header: "",
              cell: (g) => (
                <ButtonDropdown
                  variant="normal"
                  items={groupRowActions()}
                  expandToViewport
                  onItemClick={({ detail }) => onGroupAction(g, detail.id)}
                >
                  Manage
                </ButtonDropdown>
              ),
            },
          ]}
          items={groupItems}
          loading={loading}
          loadingText="Loading groups"
          empty={<Box color="text-body-secondary">No groups yet.</Box>}
          variant="embedded"
        />
      )}
    </SpaceBetween>
  );

  const rulesPanel = (
    <SpaceBetween size="l">
      <Box variant="p" color="text-body-secondary">
        Rules use substring or regex against the active <b>URL</b> or batched <b>keystroke</b> text. Use{" "}
        <b>cooldown</b> to avoid spamming the same match. Scopes can be combined. Click a rule name or{" "}
        <b>Trigger history</b> to see past firings per agent.
      </Box>
      {!isNarrow && (
        <Button variant="primary" onClick={openCreateRule}>
          Create alert rule
        </Button>
      )}
      {isNarrow ? (
        loading && ruleItems.length === 0 ? (
          <Box color="text-body-secondary">Loading rules…</Box>
        ) : ruleItems.length === 0 ? (
          <Box color="text-body-secondary">No alert rules yet.</Box>
        ) : (
          <SpaceBetween size="m">
            {ruleItems.map((r) => (
              <Box key={r.id} variant="div" className="vantyr-users-mobile-card">
                <SpaceBetween size="s">
                  <Box variant="h3" tagOverride="div" fontSize="heading-m">
                    <Button variant="inline-link" onClick={() => setHistoryRule(r)}>
                      {r.name || `Rule #${r.id}`}
                    </Button>
                  </Box>
                  <Box color="text-body-secondary">
                    {r.channel} · {r.match_mode} · cooldown {r.cooldown_secs}s ·{" "}
                    {r.enabled ? "On" : "Off"} ·{" "}
                    {r.take_screenshot ? "📷 Screenshot" : "No screenshot"}
                  </Box>
                  <Box fontSize="body-s" className="vantyr-wrap-anywhere">
                    {r.pattern}
                  </Box>
                  <Box color="text-body-secondary" fontSize="body-s">
                    {formatScopesLabel(r.scopes, groups ?? [], agentsById)}
                  </Box>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={() => setHistoryRule(r)}>Trigger history</Button>
                    <div className="vantyr-users-manage-slot">
                      <ButtonDropdown
                        variant="primary"
                        items={ruleRowActions()}
                        expandToViewport
                        onItemClick={({ detail }) => onRuleAction(r, detail.id)}
                      >
                        Manage
                      </ButtonDropdown>
                    </div>
                  </SpaceBetween>
                </SpaceBetween>
              </Box>
            ))}
          </SpaceBetween>
        )
      ) : (
        <Table
          columnDefinitions={[
            {
              id: "name",
              header: "Name",
              cell: (r) => (
                <Button variant="inline-link" onClick={() => setHistoryRule(r)}>
                  {r.name || `Rule #${r.id}`}
                </Button>
              ),
            },
            { id: "ch", header: "Channel", cell: (r) => r.channel },
            { id: "pat", header: "Pattern", cell: (r) => <Box className="vantyr-wrap-anywhere">{r.pattern}</Box> },
            { id: "mode", header: "Match", cell: (r) => r.match_mode },
            { id: "cd", header: "Cooldown (s)", cell: (r) => String(r.cooldown_secs) },
            {
              id: "en",
              header: "Status",
              cell: (r) => (
                <Badge color={r.enabled ? "green" : "grey"}>
                  {r.enabled ? "Enabled" : "Disabled"}
                </Badge>
              ),
            },
            {
              id: "screenshot",
              header: "Screenshot",
              cell: (r) => (
                <Badge color={r.take_screenshot ? "blue" : "grey"}>
                  {r.take_screenshot ? "On" : "Off"}
                </Badge>
              ),
            },
            {
              id: "scopes",
              header: "Scopes",
              cell: (r) => formatScopesLabel(r.scopes, groups ?? [], agentsById),
            },
            {
              id: "act",
              header: "",
              cell: (r) => (
                <ButtonDropdown
                  variant="normal"
                  items={ruleRowActions()}
                  expandToViewport
                  onItemClick={({ detail }) => onRuleAction(r, detail.id)}
                >
                  Manage
                </ButtonDropdown>
              ),
            },
          ]}
          items={ruleItems}
          loading={loading}
          loadingText="Loading rules"
          empty={<Box color="text-body-secondary">No alert rules yet.</Box>}
          variant="embedded"
        />
      )}
    </SpaceBetween>
  );

  const globalHistoryPanel = (
    <HistoryTable
      loading={globalHistoryLoading}
      events={globalHistory}
      showRuleName={true}
      collectionProps={globalCollectionProps}
      filterProps={globalFilterProps}
      paginationProps={globalPaginationProps}
      displayItems={globalDisplayItems}
      onPreviewScreenshot={(id) => setPreviewEventId(id)}
      onNavigateToAgent={(id) => navigate(`/agents/${id}`)}
      onGoToTimeline={goToTimeline}
      onRefresh={() => rules && void fetchGlobalHistory(rules)}
      title="Notification history"
      description="All fired notifications across every rule and agent, newest first."
    />
  );

  const pageHeader =
    mode === "groups" ? (
      <Header
        variant="h1"
        description="Create groups and assign agents. On the overview, use Actions → Add selected to group for bulk membership."
        actions={isNarrow ? undefined : headerActions}
      >
        Agent groups
      </Header>
    ) : (
      <Header
        variant="h1"
        description="Attach URL or keystroke rules to all agents, a group, or one computer. Review fired notifications under History."
        actions={isNarrow ? undefined : headerActions}
      >
        Alerts
      </Header>
    );

  const alertsMain =
    mode === "alerts" && isNarrow ? (
      <SpaceBetween size="m">
        <SegmentedControl
          className="vantyr-notify-view-toggle"
          label="View"
          selectedId={alertsTab}
          options={[
            { id: "rules", text: "Alert rules" },
            { id: "history", text: "History" },
          ]}
          onChange={({ detail }) => setAlertsTab(detail.selectedId as AlertsTabId)}
        />
        {alertsTab === "rules" ? rulesPanel : globalHistoryPanel}
      </SpaceBetween>
    ) : mode === "alerts" ? (
      <Tabs
        activeTabId={alertsTab}
        onChange={({ detail }) => setAlertsTab(detail.activeTabId as AlertsTabId)}
        tabs={[
          { label: "Alert rules", id: "rules", content: rulesPanel },
          { label: "History", id: "history", content: globalHistoryPanel },
        ]}
      />
    ) : null;

  return (
    <ContentLayout header={pageHeader}>
      <div className="vantyr-admin-page vantyr-notify-page sx-console">
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}

          {isNarrow && mobileToolbar}

          {mode === "groups" ? groupsPanel : alertsMain}
        </SpaceBetween>

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
          isNarrow={isNarrow}
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
          isNarrow={isNarrow}
          agentOptions={agentOptions}
          groupOptions={groupOptions}
          onSave={handleSaveRule}
        />

        <Modal
          visible={Boolean(historyRule)}
          onDismiss={() => {
            setHistoryRule(null);
            setHistoryEvents([]);
          }}
          header={
            historyRule
              ? `Trigger history: ${historyRule.name || `Rule #${historyRule.id}`}`
              : "Trigger history"
          }
          size="max"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  disabled={!historyRule || historyLoading}
                  iconName="refresh"
                  onClick={() => historyRule && void fetchRuleHistory(historyRule)}
                >
                  Refresh
                </Button>
                <Button
                  variant="link"
                  onClick={() => {
                    setHistoryRule(null);
                    setHistoryEvents([]);
                  }}
                >
                  Close
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <HistoryTable
            loading={historyLoading}
            events={historyEvents}
            showRuleName={false}
            collectionProps={historyCollectionProps}
            filterProps={historyFilterProps}
            paginationProps={historyPaginationProps}
            displayItems={historyDisplayItems}
            onPreviewScreenshot={(id) => setPreviewEventId(id)}
            onNavigateToAgent={(id) => navigate(`/agents/${id}`)}
            onGoToTimeline={goToTimeline}
            onRefresh={() => historyRule && void fetchRuleHistory(historyRule)}
          />
        </Modal>

        {/* ── Delete group confirm ───────────────────────────────── */}
        <Modal
          visible={Boolean(deleteGroup)}
          onDismiss={() => setDeleteGroup(null)}
          header="Delete group?"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setDeleteGroup(null)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void confirmDeleteGroup()}>
                  Delete
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          Delete &quot;{deleteGroup?.name}&quot;? Alert rule scopes referencing this group will be removed (cascade).
        </Modal>

        {/* ── Delete rule confirm ────────────────────────────────── */}
        <Modal
          visible={Boolean(deleteRule)}
          onDismiss={() => setDeleteRule(null)}
          header="Delete alert rule?"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setDeleteRule(null)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void confirmDeleteRule()}>
                  Delete
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          Delete rule #{deleteRule?.id}
          {deleteRule?.name ? ` (${deleteRule.name})` : ""}?
        </Modal>

        {/* ── Screenshot preview modal ───────────────────────────── */}
        <ScreenshotPreviewModal
          eventId={previewEventId}
          visible={previewEventId !== null}
          onClose={() => setPreviewEventId(null)}
        />
      </div>
    </ContentLayout>
  );
}
