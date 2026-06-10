import { Box, Button, Badge, Header, Modal, Pagination, SpaceBetween, Table, TextFilter, useCollection } from "../ui/console";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";

interface AlertRuleEventRow {
  id: number;
  rule_id: number | null;
  rule_name: string;
  channel: "url" | "keys" | string;
  snippet: string;
  has_screenshot: boolean;
  screenshot_requested: boolean;
  created_at: string;
}

interface AlertsTabProps {
  agentId: string;
  /** When provided, clicking "View in Timeline" navigates to the activity tab at the given timestamp. */
  onViewTimeline?: (timestamp: string) => void;
}

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

export function AlertsTab({ agentId, onViewTimeline }: AlertsTabProps) {
  const [items, setItems] = useState<AlertRuleEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(
        apiUrl(`/agents/${agentId}/alert-rule-events?limit=500&offset=0`),
        { credentials: "include" }
      );
      if (!response.ok) {
        setItems([]);
        return;
      }
      const data = await response.json();
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      setItems(
        rows.map((row: Record<string, unknown>) => ({
          id: Number(row.id ?? 0),
          rule_id: row.rule_id != null ? Number(row.rule_id) : null,
          rule_name: String(row.rule_name ?? ""),
          channel: String(row.channel ?? ""),
          snippet: String(row.snippet ?? ""),
          has_screenshot: Boolean(row.has_screenshot),
          screenshot_requested: Boolean(row.screenshot_requested),
          created_at: String(row.created_at ?? ""),
        }))
      );
    } catch (err) {
      console.error("Failed to fetch alert rule events:", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const { items: displayItems, collectionProps, filterProps, paginationProps } = useCollection(
    items,
    {
      filtering: {
        empty: "No alert matches yet",
        noMatch: "No rows match the filter",
        filteringFunction: (item, filteringText) => {
          const q = filteringText.toLowerCase();
          return (
            (item.rule_name || "").toLowerCase().includes(q) ||
            (item.snippet || "").toLowerCase().includes(q) ||
            (item.channel || "").toLowerCase().includes(q)
          );
        },
      },
      pagination: { pageSize: 25 },
      sorting: {
        defaultState: {
          sortingColumn: { sortingField: "created_at" },
          isDescending: true,
        },
      },
    }
  );

  return (
    <>
      <Table
        {...collectionProps}
        loading={loading}
        loadingText="Loading alert history…"
        columnDefinitions={[
          {
            id: "created_at",
            header: "Time",
            cell: (item) => fmtDateTime(item.created_at),
            sortingField: "created_at",
            width: 175,
          },
          {
            id: "rule_name",
            header: "Rule",
            cell: (item) => item.rule_name || "—",
            sortingField: "rule_name",
            width: 200,
          },
          {
            id: "channel",
            header: "Channel",
            cell: (item) => (
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
            cell: (item) => (
              <Box className="vantyr-monospace" fontSize="body-s">
                {item.snippet || "—"}
              </Box>
            ),
          },
          {
            id: "shot",
            header: "Screenshot",
            cell: (item) => {
              if (item.has_screenshot) {
                return (
                  <Button
                    variant="inline-link"
                    iconName="zoom-to-fit"
                    onClick={() => setPreviewEventId(item.id)}
                  >
                    View
                  </Button>
                );
              }
              if (item.screenshot_requested) {
                return (
                  <span title="Screenshot was requested but not captured.">
                    <Box color="text-body-secondary" fontSize="body-s">
                      Not captured
                    </Box>
                  </span>
                );
              }
              return (
                <span title='Enable "Take screenshot on trigger" on the alert rule.'>
                  <Box color="text-body-secondary" fontSize="body-s">
                    Off
                  </Box>
                </span>
              );
            },
            width: 110,
          },
          ...(onViewTimeline
            ? [
                {
                  id: "timeline",
                  header: "Timeline",
                  cell: (item: AlertRuleEventRow) => (
                    <Button
                      variant="inline-link"
                      iconName="angle-right"
                      onClick={() => onViewTimeline(item.created_at)}
                    >
                      View
                    </Button>
                  ),
                  width: 90,
                },
              ]
            : []),
        ]}
        items={displayItems}
        variant="container"
        stickyHeader
        header={
          <Header
            counter={`(${items.length})`}
            actions={
              <Button iconName="refresh" onClick={fetchEvents}>
                Refresh
              </Button>
            }
          >
            Alert notifications
          </Header>
        }
        filter={
          <TextFilter
            {...filterProps}
            filteringPlaceholder="Search by rule name, channel, or matched text"
          />
        }
        pagination={<Pagination {...paginationProps} />}
        empty={
          <Box textAlign="center" color="inherit">
            <SpaceBetween size="m">
              <Box variant="p" color="inherit">
                No alert rules have fired for this agent yet. When URL or keystroke telemetry matches a
                rule, a row appears here and the dashboard can show a live notification.
              </Box>
            </SpaceBetween>
          </Box>
        }
      />

      <ScreenshotPreviewModal
        eventId={previewEventId}
        visible={previewEventId !== null}
        onClose={() => setPreviewEventId(null)}
      />
    </>
  );
}
