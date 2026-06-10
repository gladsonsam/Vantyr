import { Table, Header, TextFilter, Pagination, Box, Button } from "../ui/console";
import { fmtDateTime } from "../../lib/utils";

export interface AlertRuleHistoryEventRow {
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

export interface HistoryTableProps {
  loading: boolean;
  events: AlertRuleHistoryEventRow[];
  showRuleName: boolean;
  collectionProps: any;
  filterProps: any;
  paginationProps: any;
  displayItems: AlertRuleHistoryEventRow[];
  onPreviewScreenshot: (eventId: number) => void;
  onNavigateToAgent: (agentId: string) => void;
  onGoToTimeline: (agentId: string, timestamp: string) => void;
  onRefresh?: () => void;
  title?: string;
  description?: string;
}

import { Badge } from "../ui/console";

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

export function HistoryTable({
  loading,
  events,
  showRuleName,
  collectionProps,
  filterProps,
  paginationProps,
  displayItems,
  onPreviewScreenshot,
  onNavigateToAgent,
  onGoToTimeline,
  onRefresh,
  title,
  description,
}: HistoryTableProps) {
  const columns = [
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
        <Button variant="inline-link" onClick={() => onNavigateToAgent(item.agent_id)}>
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
        <Box className="vantyr-monospace" fontSize="body-s">
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
          onPreview={onPreviewScreenshot}
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
          onClick={() => onGoToTimeline(item.agent_id, item.created_at)}
        >
          View
        </Button>
      ),
      width: 90,
    },
  ];

  const header = title ? (
    <Header
      counter={events.length > 0 ? `(${events.length})` : undefined}
      description={description}
      actions={
        onRefresh && (
          <Button iconName="refresh" loading={loading} onClick={onRefresh}>
            Refresh
          </Button>
        )
      }
    >
      {title}
    </Header>
  ) : undefined;

  return (
    <Table
      {...collectionProps}
      loading={loading}
      loadingText={title ? `Loading ${title.toLowerCase()}…` : "Loading trigger history…"}
      columnDefinitions={columns}
      items={displayItems}
      variant={title ? "container" : "embedded"}
      stickyHeader
      header={header}
      filter={
        <TextFilter
          {...filterProps}
          filteringPlaceholder={
            showRuleName
              ? "Search by rule, agent, channel, or matched text"
              : "Search by agent, channel, or matched text"
          }
        />
      }
      pagination={<Pagination {...paginationProps} />}
      empty={
        <Box textAlign="center" color="inherit">
          <Box variant="p" color="text-body-secondary">
            {loading ? "Loading…" : "No events matched."}
          </Box>
        </Box>
      }
    />
  );
}
