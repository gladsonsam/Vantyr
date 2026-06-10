import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import ButtonDropdown from "@cloudscape-design/components/button-dropdown";
import type { ButtonDropdownProps } from "@cloudscape-design/components/button-dropdown";

interface FullPageHeaderProps {
  totalAgents: number;
  onlineCount: number;
  selectedCount: number;
  selectedHasOnline?: boolean;
  selectedHasOffline?: boolean;
  selectedOnlineCount?: number;
  selectedOfflineCount?: number;
  onRefresh: () => void;
  onWakeSelected: () => void;
  onBulkScript: () => void;
  onLockSelected: () => void;
  onRestartSelected: () => void;
  onShutdownSelected: () => void;
  /** Admin: permanently forget agents from the server. */
  onDeleteSelected?: () => void;
  /** Admin: add all selected agents to an agent group (opens group picker from overview). */
  onBulkAddToGroup?: () => void;
  /** Admin: open enrollment / connection hints. */
  onAddAgent?: () => void;
}

export function FullPageHeader({
  totalAgents,
  onlineCount,
  selectedCount,
  selectedHasOnline = true,
  selectedHasOffline = true,
  selectedOnlineCount = 0,
  selectedOfflineCount = 0,
  onRefresh,
  onWakeSelected,
  onBulkScript,
  onLockSelected,
  onRestartSelected,
  onShutdownSelected,
  onDeleteSelected,
  onBulkAddToGroup,
  onAddAgent,
}: FullPageHeaderProps) {
  const bulkItems: ButtonDropdownProps.ItemOrGroup[] = [
    ...(selectedHasOffline ? [{ id: "wake", text: `Wake offline (${selectedOfflineCount})` }] : []),
    // Only show online-required actions when they can succeed on at least one selection.
    ...(selectedHasOnline
      ? ([
          { id: "script", text: `Run script (${selectedOnlineCount})` },
          { id: "lock", text: `Lock (${selectedOnlineCount})` },
          { id: "restart", text: `Restart (${selectedOnlineCount})` },
          { id: "shutdown", text: `Shutdown (${selectedOnlineCount})` },
        ] as ButtonDropdownProps.ItemOrGroup[])
      : []),
    ...(onBulkAddToGroup != null ? [{ id: "add_group", text: "Add selected to group" }] : []),
    ...(onDeleteSelected != null ? [{ id: "delete", text: "Delete selected (forget)" }] : []),
  ];

  const onBulkActionClick: ButtonDropdownProps["onItemClick"] = ({ detail }) => {
    switch (detail.id) {
      case "wake":
        onWakeSelected();
        break;
      case "script":
        onBulkScript();
        break;
      case "lock":
        onLockSelected();
        break;
      case "restart":
        onRestartSelected();
        break;
      case "shutdown":
        onShutdownSelected();
        break;
      case "add_group":
        onBulkAddToGroup?.();
        break;
      case "delete":
        onDeleteSelected?.();
        break;
      default:
        break;
    }
  };

  return (
    <Header
      variant="h1"
      counter={`(${totalAgents})`}
      description={`Connected ${onlineCount} of ${totalAgents} agents${selectedCount > 0 ? `, ${selectedCount} selected` : ""}`}
      actions={
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Button onClick={onRefresh} iconName="refresh">
            Refresh
          </Button>
          {onAddAgent != null ? (
            <Button variant="primary" onClick={onAddAgent} iconName="add-plus">
              Add agent
            </Button>
          ) : null}
          {selectedCount > 0 && (
            <ButtonDropdown
              items={bulkItems}
              onItemClick={onBulkActionClick}
              variant="normal"
              ariaLabel={`Bulk actions for ${selectedCount} selected agent${selectedCount === 1 ? "" : "s"}`}
              nativeTriggerAttributes={{
                className: "sentinel-overview-actions-pill",
              }}
            >
              Actions ({selectedCount})
            </ButtonDropdown>
          )}
        </SpaceBetween>
      }
    >
      Agents
    </Header>
  );
}
