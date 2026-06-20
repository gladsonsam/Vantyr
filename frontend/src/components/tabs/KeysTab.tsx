import { Table, Box, Header, Pagination, TextFilter, SpaceBetween, Toggle, Button } from "../ui/console";
import { useCollection } from "../../hooks/useCollection";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/utils";
import { prettyAppLabel } from "../../lib/app-names";
import { AppIcon } from "../common/AppIcon";
import type { AgentInfo } from "../../lib/types";
import { capabilityAvailable } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";

interface KeystrokeEvent {
  id: number;
  exe_name: string;
  app_display?: string;
  window_title: string;
  keys: string;
  timestamp: string;
  user?: string | null;
}

interface KeysTabProps {
  agentId: string;
  agentInfo?: AgentInfo | null;
}

export function KeysTab({ agentId, agentInfo }: KeysTabProps) {
  const [items, setItems] = useState<KeystrokeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCorrected, setShowCorrected] = useState(false);
  const keysAvailable = capabilityAvailable(agentInfo, "keyboard_monitor");

  const fetchKeystrokes = useCallback(async () => {
    if (!keysAvailable) {
      setItems([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const { rows } = await api.keys(agentId, { limit: 500 });
      setItems(
        rows.map((row) => ({
          id: 0,
          exe_name: row.app ?? "—",
          app_display: row.app_display?.trim() ? row.app_display : (row.app ?? "—"),
          window_title: row.window_title ?? "—",
          keys: row.text ?? "",
          timestamp: row.updated_at || row.started_at || "",
          user: row.user ?? null,
        })),
      );
    } catch (err) {
      console.error("Failed to fetch keystrokes:", err);
    } finally {
      setLoading(false);
    }
  }, [agentId, keysAvailable]);

  useEffect(() => {
    void fetchKeystrokes();
  }, [fetchKeystrokes]);

  const applyBackspaceCorrection = (text: string): string => {
    const stack: string[] = [];
    let i = 0;
    
    while (i < text.length) {
      if (text.startsWith("[⌫]", i)) {
        if (stack.length > 0) stack.pop();
        i += 3;
      } else if (text.startsWith("[Del]", i)) {
        i += 5;
      } else {
        stack.push(text[i]);
        i++;
      }
    }
    
    return stack.join("");
  };

  const { items: displayItems, collectionProps, filterProps, paginationProps } = useCollection(
    items,
    {
      filtering: {
        empty: "No keystrokes found",
        noMatch: "No keystrokes match the filter",
        filteringFunction: (item, filteringText) => {
          const searchText = filteringText.toLowerCase();
          return (
            (item.app_display || "").toLowerCase().includes(searchText) ||
            (item.exe_name || "").toLowerCase().includes(searchText) ||
            (item.window_title || "").toLowerCase().includes(searchText) ||
            (item.keys || "").toLowerCase().includes(searchText) ||
            (item.user || "").toLowerCase().includes(searchText)
          );
        },
      },
      pagination: { pageSize: 50 },
      sorting: {
        defaultState: {
          sortingColumn: { sortingField: "timestamp" },
          isDescending: true,
        },
      },
    }
  );

  if (!keysAvailable) {
    return <CapabilityNotice info={agentInfo} capability="keyboard_monitor" title="Keystrokes unavailable" />;
  }

  return (
    <Table
      {...collectionProps}
      loading={loading}
      loadingText="Loading keystrokes..."
      columnDefinitions={[
        {
          id: "user",
          header: "User",
          cell: (item) => item.user || "—",
          sortingField: "user",
          width: 160,
        },
        {
          id: "timestamp",
          header: "Time",
          cell: (item) => fmtDateTime(item.timestamp),
          sortingField: "timestamp",
          width: 180,
        },
        {
          id: "app",
          header: "Application",
          cell: (item) => (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AppIcon agentId={agentId} exeName={item.exe_name} size={16} />
                <button
                  type="button"
                  onClick={() =>
                    filterProps.onChange({
                      detail: { filteringText: item.exe_name ?? "" },
                    } as Parameters<typeof filterProps.onChange>[0])
                  }
                  title="Filter table by this app"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "inherit",
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  {prettyAppLabel({ exeName: item.exe_name, appDisplay: item.app_display })}
                </button>
              </div>
              <Box className="vantyr-monospace" fontSize="body-s" color="text-body-secondary">
                {item.exe_name}
              </Box>
            </div>
          ),
          sortingField: "exe_name",
          width: 150,
        },
        {
          id: "window",
          header: "Window",
          cell: (item) => (
            <Box fontSize="body-s">{item.window_title}</Box>
          ),
          sortingField: "window_title",
        },
        {
          id: "keys",
          header: "Keystrokes",
          cell: (item) => (
            <Box className="vantyr-monospace" fontSize="body-s">
              {showCorrected ? applyBackspaceCorrection(item.keys || "") : item.keys || ""}
            </Box>
          ),
        },
      ]}
      items={displayItems}
      variant="container"
      stickyHeader
      header={
        <Header
          counter={`(${items.length})`}
          actions={
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <Toggle
                checked={showCorrected}
                onChange={({ detail }) => setShowCorrected(detail.checked)}
              >
                Show corrected
              </Toggle>
              <Button iconName="refresh" onClick={fetchKeystrokes}>
                Refresh
              </Button>
            </SpaceBetween>
          }
        >
          Keystrokes
        </Header>
      }
      filter={
        <TextFilter
          {...filterProps}
          filteringPlaceholder="Search by app, window, or text"
        />
      }
      pagination={<Pagination {...paginationProps} />}
      empty={
        <Box textAlign="center" color="inherit">
          <Box variant="p" color="inherit">
            No keystrokes recorded
          </Box>
        </Box>
      }
    />
  );
}
