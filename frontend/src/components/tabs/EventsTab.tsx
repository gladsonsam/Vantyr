import { Badge, Box, Button, Container, ExpandableSection, Header, Modal, Pagination, SpaceBetween, StatusIndicator, Table, Tabs, TextFilter, useCollection } from "../ui/console";
import { useCallback, useEffect, useState } from "react";
import { api, apiUrl } from "../../lib/api";
import type { AppBlockEvent, AlertRuleRow, AppBlockRule } from "../../lib/types";
import { AppIcon } from "../common/AppIcon";
import { fmtDateTime } from "../../lib/utils";

// ── Screenshot preview modal ──────────────────────────────────────────────────

function ScreenshotModal({ eventId, onClose }: { eventId: number | null; onClose: () => void }) {
  return (
    <Modal
      visible={eventId != null}
      onDismiss={onClose}
      header="Screenshot"
      size="max"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            {eventId != null && (
              <Button href={apiUrl(`/alert-rule-events/${eventId}/screenshot`)} target="_blank" iconName="external">
                Open in new tab
              </Button>
            )}
            <Button variant="link" onClick={onClose}>Close</Button>
          </SpaceBetween>
        </Box>
      }
    >
      {eventId != null && (
        <div style={{ textAlign: "center" }}>
          <img
            src={apiUrl(`/alert-rule-events/${eventId}/screenshot`)}
            alt="Alert screenshot"
            style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 6 }}
          />
        </div>
      )}
    </Modal>
  );
}

// ── Alert events table ────────────────────────────────────────────────────────

interface AlertEventRow {
  id: number;
  rule_id: number | null;
  rule_name: string;
  channel: string;
  snippet: string;
  has_screenshot: boolean;
  screenshot_requested: boolean;
  created_at: string;
}

function AlertEventsTable({
  agentId,
  onViewTimeline,
}: {
  agentId: string;
  onViewTimeline?: (ts: string) => void;
}) {
  const [items, setItems] = useState<AlertEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.agentAlertRuleEvents(agentId, { limit: 500, offset: 0 }).catch(() => ({
        rows: [],
      }));
      setItems(
        (data.rows ?? []).map((r: Record<string, unknown>) => ({
          id: Number(r.id ?? 0),
          rule_id: r.rule_id != null ? Number(r.rule_id) : null,
          rule_name: String(r.rule_name ?? ""),
          channel: String(r.channel ?? ""),
          snippet: String(r.snippet ?? ""),
          has_screenshot: Boolean(r.has_screenshot),
          screenshot_requested: Boolean(r.screenshot_requested),
          created_at: String(r.created_at ?? ""),
        })),
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const { items: displayed, collectionProps, filterProps, paginationProps } = useCollection(items, {
    filtering: {
      empty: "No alert events yet",
      noMatch: "No matches",
      filteringFunction: (item, text) => {
        const q = text.toLowerCase();
        return item.rule_name.toLowerCase().includes(q) || item.snippet.toLowerCase().includes(q) || item.channel.toLowerCase().includes(q);
      },
    },
    pagination: { pageSize: 25 },
    sorting: { defaultState: { sortingColumn: { sortingField: "created_at" }, isDescending: true } },
  });

  return (
    <>
      <Table
        {...collectionProps}
        loading={loading}
        loadingText="Loading…"
        items={displayed}
        variant="embedded"
        stickyHeader
        header={<Header counter={`(${items.length})`}>Alert events</Header>}
        filter={<TextFilter {...filterProps} filteringPlaceholder="Filter by rule, channel, or text" />}
        pagination={<Pagination {...paginationProps} />}
        empty={<Box textAlign="center" padding="l" color="text-body-secondary">No alert rules have matched yet.</Box>}
        columnDefinitions={[
          { id: "time", header: "Time", cell: (r) => fmtDateTime(r.created_at), sortingField: "created_at", width: 170 },
          { id: "rule", header: "Rule", cell: (r) => r.rule_name || "—", sortingField: "rule_name", width: 180 },
          {
            id: "channel",
            header: "Channel",
            cell: (r) => <Badge color={r.channel === "url" ? "blue" : "grey"}>{r.channel === "url" ? "URL" : r.channel === "keys" ? "Keys" : r.channel}</Badge>,
            width: 80,
          },
          { id: "snippet", header: "Matched text", cell: (r) => <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.snippet || "—"}</span></Box> },
          {
            id: "shot",
            header: "Screenshot",
            cell: (r) => r.has_screenshot
              ? <Button variant="inline-link" iconName="zoom-to-fit" onClick={() => setPreviewId(r.id)}>View</Button>
              : <Box color="text-body-secondary" fontSize="body-s">{r.screenshot_requested ? "Not captured" : "Off"}</Box>,
            width: 110,
          },
          ...(onViewTimeline ? [{
            id: "timeline",
            header: "",
            cell: (r: AlertEventRow) => (
              <Button variant="inline-link" iconName="angle-right" onClick={() => onViewTimeline(r.created_at)}>Timeline</Button>
            ),
            width: 90,
          }] : []),
        ]}
      />
      <ScreenshotModal eventId={previewId} onClose={() => setPreviewId(null)} />
    </>
  );
}

// ── App block events table ────────────────────────────────────────────────────

function AppBlockEventsTable({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<AppBlockEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.appBlockEventsForAgent(agentId, { limit: 500 });
      setItems(data.rows);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const { items: displayed, collectionProps, paginationProps } = useCollection(items, {
    pagination: { pageSize: 25 },
    sorting: { defaultState: { sortingColumn: { sortingField: "killed_at" }, isDescending: true } },
  });

  return (
    <Table
      {...collectionProps}
      loading={loading}
      loadingText="Loading…"
      items={displayed}
      variant="embedded"
      stickyHeader
      header={<Header counter={`(${items.length})`}>App block kills</Header>}
      pagination={<Pagination {...paginationProps} />}
      empty={<Box textAlign="center" padding="l" color="text-body-secondary">No processes have been killed by app block rules yet.</Box>}
      columnDefinitions={[
        { id: "time", header: "Time", cell: (r) => fmtDateTime(r.killed_at), sortingField: "killed_at", width: 170 },
        {
          id: "exe",
          header: "EXE",
          cell: (r) => (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AppIcon agentId={agentId} exeName={r.exe_name} size={16} />
              <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.exe_name}</span></Box>
            </div>
          ),
        },
        { id: "rule", header: "Rule", cell: (r) => r.rule_name ?? <Box color="text-body-secondary">—</Box>, width: 200 },
      ]}
    />
  );
}

// ── Active rules summary ──────────────────────────────────────────────────────

function scopeBadge(kind?: string) {
  if (kind === "all") return <Badge color="red">All devices</Badge>;
  if (kind === "group") return <Badge color="severity-medium">Group</Badge>;
  return <Badge color="blue">This device</Badge>;
}

function ActiveRules({ agentId }: { agentId: string }) {
  const [alertRules, setAlertRules] = useState<AlertRuleRow[]>([]);
  const [appRules, setAppRules] = useState<AppBlockRule[]>([]);
  const [netBlocked, setNetBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  const [netSource, setNetSource] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.agentEffectiveRules(agentId)
      .then((r) => {
        setAlertRules(r.alert_rules);
        setAppRules(r.app_block_rules);
        setNetBlocked(r.internet_blocked);
        setNetSource((r as Record<string, unknown>).internet_block_source as string | null ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <Box color="text-status-inactive">Loading active rules…</Box>;

  return (
    <SpaceBetween size="m">
      {/* Internet */}
      <Container header={<Header variant="h3">Internet access</Header>}>
        <SpaceBetween direction="horizontal" size="s" alignItems="center">
          <StatusIndicator type={netBlocked ? "warning" : "success"}>
            {netBlocked ? "Blocked" : "Allowed"}
          </StatusIndicator>
          {netBlocked && netSource && netSource !== "agent" && (
            <Badge color={netSource === "all" ? "red" : "severity-medium"}>
              {netSource === "all" ? "All devices rule" : "Group rule"}
            </Badge>
          )}
          {netBlocked && (!netSource || netSource === "agent") && (
            <Badge color="blue">This device rule</Badge>
          )}
        </SpaceBetween>
      </Container>

      {/* Alert rules */}
      <Container header={<Header variant="h3" counter={`(${alertRules.length})`}>Alert rules</Header>}>
        {alertRules.length === 0
          ? <Box color="text-body-secondary">No alert rules apply to this device.</Box>
          : (
            <Table
              items={alertRules}
              variant="embedded"
              columnDefinitions={[
                { id: "name", header: "Name", cell: (r) => r.name, width: "30%" },
                { id: "pattern", header: "Pattern", cell: (r) => <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.pattern}</span></Box> },
                { id: "scope", header: "From", cell: (r) => scopeBadge(r.scope_kind), width: 120 },
              ]}
            />
          )}
      </Container>

      {/* App block rules */}
      <Container header={<Header variant="h3" counter={`(${appRules.length})`}>App blocking</Header>}>
        {appRules.length === 0
          ? <Box color="text-body-secondary">No app block rules apply to this device.</Box>
          : (
            <Table
              items={appRules}
              variant="embedded"
              columnDefinitions={[
                {
                  id: "exe",
                  header: "EXE pattern",
                  cell: (r) => (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <AppIcon agentId={agentId} exeName={r.exe_pattern} size={16} />
                      <Box fontSize="body-s"><span style={{ fontFamily: "monospace" }}>{r.exe_pattern}</span></Box>
                    </div>
                  ),
                },
                { id: "mode", header: "Match", cell: (r) => <Badge color="grey">{r.match_mode}</Badge>, width: 100 },
                { id: "scope", header: "From", cell: (r) => scopeBadge(r.scope_kind), width: 120 },
              ]}
            />
          )}
      </Container>
    </SpaceBetween>
  );
}

// ── Main EventsTab ────────────────────────────────────────────────────────────

interface EventsTabProps {
  agentId: string;
  onViewTimeline?: (timestamp: string) => void;
}

export function EventsTab({ agentId, onViewTimeline }: EventsTabProps) {
  return (
    <SpaceBetween size="l">
      <ExpandableSection
        variant="container"
        headerText="Active rules for this device"
        defaultExpanded
      >
        <ActiveRules agentId={agentId} />
      </ExpandableSection>

      <Tabs
        tabs={[
          {
            id: "alerts",
            label: "Alert events",
            content: <AlertEventsTable agentId={agentId} onViewTimeline={onViewTimeline} />,
          },
          {
            id: "appblock",
            label: "App block kills",
            content: <AppBlockEventsTable agentId={agentId} />,
          },
        ]}
      />
    </SpaceBetween>
  );
}
