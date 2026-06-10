import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import Button from "@cloudscape-design/components/button";
import ButtonDropdown from "@cloudscape-design/components/button-dropdown";
import type { ButtonDropdownProps } from "@cloudscape-design/components/button-dropdown";
import Modal from "@cloudscape-design/components/modal";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import Checkbox from "@cloudscape-design/components/checkbox";
import Box from "@cloudscape-design/components/box";
import Alert from "@cloudscape-design/components/alert";
import Tabs from "@cloudscape-design/components/tabs";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Pagination from "@cloudscape-design/components/pagination";
import TextFilter from "@cloudscape-design/components/text-filter";
import Badge from "@cloudscape-design/components/badge";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { api, apiUrl } from "../lib/api";
import { fmtDateTime } from "../lib/utils";
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

type ScopeFormRow = {
  kind: AlertRuleScopeKind;
  group_id: string;
  agent_id: string;
};

interface AlertRuleHistoryEventRow {
  id: number;
  agent_id: string;
  agent_name: string;
  rule_name: string;
  channel: string;
  snippet: string;
  has_screenshot: boolean;
  screenshot_requested: boolean;
  created_at: string;
}

function emptyScopeRow(): ScopeFormRow {
  return { kind: "all", group_id: "", agent_id: "" };
}

function scopesToForm(scopes: AlertRuleScope[]): ScopeFormRow[] {
  if (scopes.length === 0) return [emptyScopeRow()];
  return scopes.map((s) => ({
    kind: s.kind,
    group_id: s.group_id ?? "",
    agent_id: s.agent_id ?? "",
  }));
}

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

const CHANNEL_OPTIONS = [
  { label: "URL", value: "url" },
  { label: "Keystrokes", value: "keys" },
];

const MATCH_OPTIONS = [
  { label: "Substring", value: "substring" },
  { label: "Regex", value: "regex" },
];

const SCOPE_KIND_OPTIONS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

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

// ─── Screenshot Cell ──────────────────────────────────────────────────────────

function ScreenshotCell({
  eventId,
  hasScreenshot,
  screenshotRequested,
  onPreview,
}: {
  eventId: number;
  hasScreenshot: boolean;
  screenshotRequested: boolean;
  onPreview: (id: number) => void;
}) {
  if (hasScreenshot) {
    return (
      <Button
        variant="inline-link"
        onClick={() => onPreview(eventId)}
        iconName="zoom-to-fit"
      >
        View
      </Button>
    );
  }
  if (screenshotRequested) {
    return (
      <span title="Screenshot was requested but not captured (may have failed or still in progress).">
        <Box color="text-body-secondary" fontSize="body-s">
          Not captured
        </Box>
      </span>
    );
  }
  return (
    <span title='Enable "Take screenshot on trigger" on the alert rule to capture screenshots.'>
      <Box color="text-body-secondary" fontSize="body-s">
        Off
      </Box>
    </span>
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

  const [groupModal, setGroupModal] = useState<null | { mode: "create" } | { mode: "edit"; g: AgentGroup }>(null);
  const [groupForm, setGroupForm] = useState({ name: "", description: "" });

  const [membersModal, setMembersModal] = useState<null | { group: AgentGroup; memberIds: string[] }>(null);
  const [addAgentId, setAddAgentId] = useState<string>("");
  type AddableMemberRow = { agentId: string; label: string };
  const [membersAddSelection, setMembersAddSelection] = useState<AddableMemberRow[]>([]);

  const [ruleModal, setRuleModal] = useState<null | { mode: "create" } | { mode: "edit"; rule: AlertRule }>(null);
  const [ruleForm, setRuleForm] = useState({
    name: "",
    channel: "url" as AlertRuleChannel,
    pattern: "",
    match_mode: "substring" as AlertRuleMatchMode,
    case_insensitive: true,
    cooldown_secs: 300,
    enabled: true,
    take_screenshot: false,
    scopes: [emptyScopeRow()] as ScopeFormRow[],
  });

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
    setGroupForm({ name: "", description: "" });
    setGroupModal({ mode: "create" });
  };

  const openEditGroup = (g: AgentGroup) => {
    setGroupForm({ name: g.name, description: g.description ?? "" });
    setGroupModal({ mode: "edit", g });
  };

  const saveGroup = async () => {
    if (!groupModal) return;
    const name = groupForm.name.trim();
    if (!name) {
      setError("Group name is required");
      return;
    }
    setError(null);
    try {
      if (groupModal.mode === "create") {
        await api.agentGroupsCreate({ name, description: groupForm.description.trim() });
      } else {
        await api.agentGroupsUpdate(groupModal.g.id, {
          name,
          description: groupForm.description.trim(),
        });
      }
      setGroupModal(null);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const openMembers = async (g: AgentGroup) => {
    setError(null);
    try {
      const { agent_ids } = await api.agentGroupMembers(g.id);
      setMembersModal({ group: g, memberIds: agent_ids });
      setAddAgentId("");
      setMembersAddSelection([]);
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const addMember = async () => {
    if (!membersModal || !addAgentId) return;
    setError(null);
    try {
      await api.agentGroupMembersAdd(membersModal.group.id, { agent_ids: [addAgentId] });
      const { agent_ids } = await api.agentGroupMembers(membersModal.group.id);
      setMembersModal({ ...membersModal, memberIds: agent_ids });
      setAddAgentId("");
      setMembersAddSelection([]);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const addableMemberRows: AddableMemberRow[] = useMemo(() => {
    if (!membersModal) return [];
    const set = new Set(membersModal.memberIds);
    return agentOptions
      .filter((o) => !set.has(o.value))
      .map((o) => ({ agentId: o.value, label: o.label }));
  }, [membersModal, agentOptions]);

  const addSelectedMembers = async () => {
    if (!membersModal || membersAddSelection.length === 0) return;
    setError(null);
    try {
      await api.agentGroupMembersAdd(membersModal.group.id, {
        agent_ids: membersAddSelection.map((r) => r.agentId),
      });
      const { agent_ids } = await api.agentGroupMembers(membersModal.group.id);
      setMembersModal({ ...membersModal, memberIds: agent_ids });
      setMembersAddSelection([]);
      setAddAgentId("");
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const removeMember = async (agentId: string) => {
    if (!membersModal) return;
    setError(null);
    try {
      await api.agentGroupMemberRemove(membersModal.group.id, agentId);
      const { agent_ids } = await api.agentGroupMembers(membersModal.group.id);
      setMembersModal({ ...membersModal, memberIds: agent_ids });
      setMembersAddSelection([]);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const confirmDeleteGroup = async () => {
    if (!deleteGroup) return;
    setError(null);
    try {
      await api.agentGroupsDelete(deleteGroup.id);
      setDeleteGroup(null);
      setMembersModal(null);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const openCreateRule = () => {
    setRuleForm({
      name: "",
      channel: "url",
      pattern: "",
      match_mode: "substring",
      case_insensitive: true,
      cooldown_secs: 300,
      enabled: true,
      take_screenshot: false,
      scopes: [emptyScopeRow()],
    });
    setRuleModal({ mode: "create" });
  };

  const openCreateRuleForGroup = (groupId: string, groupName: string) => {
    setRuleForm({
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
    setRuleModal({ mode: "create" });
    if (mode === "alerts") setAlertsTab("rules");
  };

  const openEditRule = (rule: AlertRule) => {
    setRuleForm({
      name: rule.name,
      channel: rule.channel,
      pattern: rule.pattern,
      match_mode: rule.match_mode,
      case_insensitive: rule.case_insensitive,
      cooldown_secs: rule.cooldown_secs,
      enabled: rule.enabled,
      take_screenshot: Boolean(rule.take_screenshot),
      scopes: scopesToForm(rule.scopes),
    });
    setRuleModal({ mode: "edit", rule });
  };

  const saveRule = async () => {
    if (!ruleModal) return;
    const pattern = ruleForm.pattern.trim();
    if (!pattern) {
      setError("Pattern is required");
      return;
    }
    for (const row of ruleForm.scopes) {
      if (row.kind === "group" && !row.group_id.trim()) {
        setError("Each group scope must select a group");
        return;
      }
      if (row.kind === "agent" && !row.agent_id.trim()) {
        setError("Each agent scope must select an agent");
        return;
      }
    }
    const scopes = formScopesToApi(ruleForm.scopes);
    setError(null);
    try {
      const body = {
        name: ruleForm.name.trim(),
        channel: ruleForm.channel,
        pattern,
        match_mode: ruleForm.match_mode,
        case_insensitive: ruleForm.case_insensitive,
        cooldown_secs: ruleForm.cooldown_secs,
        enabled: ruleForm.enabled,
        take_screenshot: ruleForm.take_screenshot,
        scopes: scopes.map((s) => ({
          kind: s.kind,
          group_id: s.group_id,
          agent_id: s.agent_id,
        })),
      };
      if (ruleModal.mode === "create") {
        await api.alertRulesCreate(body);
      } else {
        await api.alertRulesUpdate(ruleModal.rule.id, body);
      }
      setRuleModal(null);
      await load();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
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

  const updateScopeRow = (index: number, patch: Partial<ScopeFormRow>) => {
    setRuleForm((prev) => {
      const scopes = [...prev.scopes];
      const cur = { ...scopes[index], ...patch };
      if (patch.kind === "all") {
        cur.group_id = "";
        cur.agent_id = "";
      }
      if (patch.kind === "group") {
        cur.agent_id = "";
      }
      if (patch.kind === "agent") {
        cur.group_id = "";
      }
      scopes[index] = cur;
      return { ...prev, scopes };
    });
  };

  const addScopeRow = () => {
    setRuleForm((prev) => ({ ...prev, scopes: [...prev.scopes, emptyScopeRow()] }));
  };

  const removeScopeRow = (index: number) => {
    setRuleForm((prev) => {
      if (prev.scopes.length <= 1) return prev;
      const scopes = prev.scopes.filter((_, i) => i !== index);
      return { ...prev, scopes };
    });
  };

  const addableAgents = useMemo(() => {
    if (!membersModal) return agentOptions;
    const set = new Set(membersModal.memberIds);
    return agentOptions.filter((o) => !set.has(o.value));
  }, [membersModal, agentOptions]);

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
    <div className="sentinel-users-toolbar-mobile">
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

  // ── History columns shared between rule history modal and global history tab ─
  const historyColumnDefs = (showRuleName: boolean) => [
    {
      id: "created_at",
      header: "Time",
      cell: (item: AlertRuleHistoryEventRow) => fmtDateTime(item.created_at),
      sortingField: "created_at",
      width: 175,
    },
    ...(showRuleName
      ? [
          {
            id: "rule_name",
            header: "Rule",
            cell: (item: AlertRuleHistoryEventRow) => item.rule_name || "—",
            sortingField: "rule_name",
            width: 160,
          },
        ]
      : []),
    {
      id: "agent",
      header: "Agent",
      cell: (item: AlertRuleHistoryEventRow) => (
        <Button variant="inline-link" onClick={() => navigate(`/agents/${item.agent_id}`)}>
          {item.agent_name.trim() ? item.agent_name : `${item.agent_id.slice(0, 8)}…`}
        </Button>
      ),
      sortingField: "agent_name",
      width: 150,
    },
    {
      id: "channel",
      header: "Channel",
      cell: (item: AlertRuleHistoryEventRow) => (
        <Badge color={item.channel === "url" ? "blue" : "grey"}>
          {item.channel === "url" ? "URL" : item.channel === "keys" ? "Keys" : item.channel}
        </Badge>
      ),
      sortingField: "channel",
      width: 80,
    },
    {
      id: "snippet",
      header: "Matched text",
      cell: (item: AlertRuleHistoryEventRow) => (
        <Box className="sentinel-monospace" fontSize="body-s">
          {item.snippet || "—"}
        </Box>
      ),
    },
    {
      id: "shot",
      header: "Screenshot",
      cell: (item: AlertRuleHistoryEventRow) => (
        <ScreenshotCell
          eventId={item.id}
          hasScreenshot={item.has_screenshot}
          screenshotRequested={item.screenshot_requested}
          onPreview={(id) => setPreviewEventId(id)}
        />
      ),
      width: 110,
    },
    {
      id: "timeline",
      header: "Timeline",
      cell: (item: AlertRuleHistoryEventRow) => (
        <Button
          variant="inline-link"
          iconName="angle-right"
          onClick={() => goToTimeline(item.agent_id, item.created_at)}
        >
          View
        </Button>
      ),
      width: 90,
    },
  ];

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
              <Box key={g.id} variant="div" className="sentinel-users-mobile-card">
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
                  <div className="sentinel-users-manage-slot">
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
              <Box key={r.id} variant="div" className="sentinel-users-mobile-card">
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
                  <Box fontSize="body-s" className="sentinel-wrap-anywhere">
                    {r.pattern}
                  </Box>
                  <Box color="text-body-secondary" fontSize="body-s">
                    {formatScopesLabel(r.scopes, groups ?? [], agentsById)}
                  </Box>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={() => setHistoryRule(r)}>Trigger history</Button>
                    <div className="sentinel-users-manage-slot">
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
            { id: "pat", header: "Pattern", cell: (r) => <Box className="sentinel-wrap-anywhere">{r.pattern}</Box> },
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
    <Table
      {...globalCollectionProps}
      loading={globalHistoryLoading}
      loadingText="Loading notification history…"
      columnDefinitions={historyColumnDefs(true)}
      items={globalDisplayItems}
      variant="container"
      stickyHeader
      header={
        <Header
          counter={globalHistory.length > 0 ? `(${globalHistory.length})` : undefined}
          description="All fired notifications across every rule and agent, newest first."
          actions={
            <Button
              iconName="refresh"
              loading={globalHistoryLoading}
              onClick={() => rules && void fetchGlobalHistory(rules)}
            >
              Refresh
            </Button>
          }
        >
          Notification history
        </Header>
      }
      filter={
        <TextFilter
          {...globalFilterProps}
          filteringPlaceholder="Search by rule, agent, channel, or matched text"
        />
      }
      pagination={<Pagination {...globalPaginationProps} />}
      empty={
        <Box textAlign="center" color="inherit">
          <Box variant="p" color="text-body-secondary">
            {globalHistoryLoading
              ? "Loading…"
              : "No alert rules have fired yet. Create rules under the Alert rules tab and they will appear here."}
          </Box>
        </Box>
      }
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
          className="sentinel-notify-view-toggle"
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
      <div className="sentinel-admin-page sentinel-notify-page sx-console">
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}

          {isNarrow && mobileToolbar}

          {mode === "groups" ? groupsPanel : alertsMain}
        </SpaceBetween>

      {/* ── Group modal ───────────────────────────────────────── */}
      <Modal
        visible={Boolean(groupModal)}
        onDismiss={() => setGroupModal(null)}
        header={groupModal?.mode === "create" ? "Create agent group" : "Rename agent group"}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setGroupModal(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void saveGroup()}>
                Save
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="Name">
            <Input value={groupForm.name} onChange={({ detail }) => setGroupForm((p) => ({ ...p, name: detail.value }))} />
          </FormField>
          <FormField label="Description">
            <Input
              value={groupForm.description}
              onChange={({ detail }) => setGroupForm((p) => ({ ...p, description: detail.value }))}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* ── Members modal ─────────────────────────────────────── */}
      <Modal
        visible={Boolean(membersModal)}
        onDismiss={() => setMembersModal(null)}
        header={membersModal ? `Members: ${membersModal.group.name}` : "Members"}
        size="large"
        footer={
          <Box float="right">
            <Button variant="link" onClick={() => setMembersModal(null)}>
              Close
            </Button>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="Add agent">
            <div className="sentinel-notify-members-add">
              <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={
                  addAgentId ? addableAgents.find((o) => o.value === addAgentId) ?? null : null
                }
                onChange={({ detail }) => {
                  const v = detail.selectedOption?.value;
                  setAddAgentId(typeof v === "string" ? v : "");
                }}
                options={addableAgents}
                placeholder="Choose an agent"
                filteringType="auto"
                empty="No agents available to add"
              />
              <Button disabled={!addAgentId} onClick={() => void addMember()}>
                Add
              </Button>
              </SpaceBetween>
            </div>
          </FormField>
          {addableMemberRows.length > 0 && (
            <SpaceBetween size="s">
              <Header variant="h3">Add several agents</Header>
              <Table
                trackBy="agentId"
                variant="embedded"
                selectionType="multi"
                selectedItems={membersAddSelection}
                onSelectionChange={({ detail }) =>
                  setMembersAddSelection((detail.selectedItems ?? []) as AddableMemberRow[])
                }
                columnDefinitions={[
                  {
                    id: "agent",
                    header: "Agent",
                    cell: (r: AddableMemberRow) => r.label,
                  },
                ]}
                items={addableMemberRows}
              />
              <Button
                disabled={membersAddSelection.length === 0}
                onClick={() => void addSelectedMembers()}
              >
                Add selected ({membersAddSelection.length})
              </Button>
            </SpaceBetween>
          )}
          {isNarrow ? (
            (membersModal?.memberIds.length ?? 0) === 0 ? (
              <Box color="text-body-secondary">No members in this group.</Box>
            ) : (
              <SpaceBetween size="m">
                {(membersModal?.memberIds ?? []).map((id) => (
                  <Box key={id} variant="div" className="sentinel-users-mobile-card">
                    <SpaceBetween size="s">
                      <Box fontSize="heading-s" fontWeight="bold">
                        {agentsById[id]?.name ?? id}
                      </Box>
                      <Button onClick={() => void removeMember(id)}>Remove from group</Button>
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
                  header: "Agent",
                  cell: (id: string) => agentsById[id]?.name ?? id,
                },
                {
                  id: "rm",
                  header: "",
                  cell: (id: string) => (
                    <Button variant="link" onClick={() => void removeMember(id)}>
                      Remove
                    </Button>
                  ),
                },
              ]}
              items={membersModal?.memberIds ?? []}
              empty={<Box color="text-body-secondary">No members in this group.</Box>}
              variant="embedded"
            />
          )}
        </SpaceBetween>
      </Modal>

      {/* ── Rule create / edit modal ───────────────────────────── */}
      <Modal
        visible={Boolean(ruleModal)}
        onDismiss={() => setRuleModal(null)}
        header={ruleModal?.mode === "create" ? "Create alert rule" : "Edit alert rule"}
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setRuleModal(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void saveRule()}>
                Save
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="Display name">
            <Input value={ruleForm.name} onChange={({ detail }) => setRuleForm((p) => ({ ...p, name: detail.value }))} />
          </FormField>
          <ColumnLayout columns={isNarrow ? 1 : 2}>
            <FormField label="Channel">
              <Select
                selectedOption={CHANNEL_OPTIONS.find((o) => o.value === ruleForm.channel)!}
                onChange={({ detail }) => {
                  const v = detail.selectedOption?.value as AlertRuleChannel | undefined;
                  if (v) setRuleForm((p) => ({ ...p, channel: v }));
                }}
                options={CHANNEL_OPTIONS}
              />
            </FormField>
            <FormField label="Match mode">
              <Select
                selectedOption={MATCH_OPTIONS.find((o) => o.value === ruleForm.match_mode)!}
                onChange={({ detail }) => {
                  const v = detail.selectedOption?.value as AlertRuleMatchMode | undefined;
                  if (v) setRuleForm((p) => ({ ...p, match_mode: v }));
                }}
                options={MATCH_OPTIONS}
              />
            </FormField>
          </ColumnLayout>
          <FormField
            label="Pattern"
            description={ruleForm.match_mode === "regex" ? "Rust regex; case sensitivity follows the checkbox below." : "Substring match."}
          >
            <Input value={ruleForm.pattern} onChange={({ detail }) => setRuleForm((p) => ({ ...p, pattern: detail.value }))} />
          </FormField>
          <div className="sentinel-notify-check-row">
            <SpaceBetween direction="horizontal" size="l">
              <Checkbox
                checked={ruleForm.case_insensitive}
                onChange={({ detail }) => setRuleForm((p) => ({ ...p, case_insensitive: detail.checked }))}
              >
                Case-insensitive
              </Checkbox>
              <Checkbox
                checked={ruleForm.take_screenshot}
                onChange={({ detail }) => setRuleForm((p) => ({ ...p, take_screenshot: detail.checked }))}
              >
                Take screenshot on trigger
              </Checkbox>
              <Checkbox
                checked={ruleForm.enabled}
                onChange={({ detail }) => setRuleForm((p) => ({ ...p, enabled: detail.checked }))}
              >
                Enabled
              </Checkbox>
            </SpaceBetween>
          </div>
          <FormField label="Cooldown (seconds)" description="0 = fire every matching event (can be noisy).">
            <Input
              type="number"
              value={String(ruleForm.cooldown_secs)}
              onChange={({ detail }) => {
                const n = parseInt(detail.value, 10);
                setRuleForm((p) => ({ ...p, cooldown_secs: Number.isFinite(n) ? Math.max(0, n) : 0 }));
              }}
            />
          </FormField>

          <Header variant="h3">Scopes</Header>
          {ruleForm.scopes.map((row, index) => (
            <Box key={index} padding="s" className="sentinel-notify-scope-row">
              <SpaceBetween size="s">
                <SpaceBetween direction="horizontal" size="xs" alignItems="start">
                  <FormField label="Applies to">
                    <Select
                      selectedOption={SCOPE_KIND_OPTIONS.find((o) => o.value === row.kind)!}
                      onChange={({ detail }) => {
                        const v = detail.selectedOption?.value as AlertRuleScopeKind | undefined;
                        if (v) updateScopeRow(index, { kind: v });
                      }}
                      options={SCOPE_KIND_OPTIONS}
                    />
                  </FormField>
                  {row.kind === "group" && (
                    <FormField label="Group">
                      <Select
                        selectedOption={groupOptions.find((o) => o.value === row.group_id) ?? null}
                        onChange={({ detail }) => {
                          const v = detail.selectedOption?.value;
                          updateScopeRow(index, { group_id: typeof v === "string" ? v : "" });
                        }}
                        options={groupOptions}
                        placeholder="Select group"
                        empty="Create a group first"
                      />
                    </FormField>
                  )}
                  {row.kind === "agent" && (
                    <FormField label="Agent">
                      <Select
                        selectedOption={agentOptions.find((o) => o.value === row.agent_id) ?? null}
                        onChange={({ detail }) => {
                          const v = detail.selectedOption?.value;
                          updateScopeRow(index, { agent_id: typeof v === "string" ? v : "" });
                        }}
                        options={agentOptions}
                        placeholder="Select agent"
                        filteringType="auto"
                      />
                    </FormField>
                  )}
                  <div className="sentinel-notify-scope-remove">
                    <Button
                      disabled={ruleForm.scopes.length <= 1}
                      variant="icon"
                      iconName="remove"
                      ariaLabel="Remove scope"
                      onClick={() => removeScopeRow(index)}
                    />
                  </div>
                </SpaceBetween>
              </SpaceBetween>
            </Box>
          ))}
          <Button onClick={addScopeRow}>Add scope</Button>
        </SpaceBetween>
      </Modal>

      {/* ── Per-rule history modal ─────────────────────────────── */}
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
        <Table
          {...historyCollectionProps}
          loading={historyLoading}
          loadingText="Loading trigger history…"
          columnDefinitions={historyColumnDefs(false)}
          items={historyDisplayItems}
          variant="embedded"
          stickyHeader
          filter={
            <TextFilter
              {...historyFilterProps}
              filteringPlaceholder="Search by agent, channel, or matched text"
            />
          }
          pagination={<Pagination {...historyPaginationProps} />}
          empty={
            <Box textAlign="center" color="inherit">
              <Box variant="p" color="text-body-secondary">
                {historyLoading
                  ? "…"
                  : "This rule has not fired yet, or history was cleared for those agents."}
              </Box>
            </Box>
          }
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
