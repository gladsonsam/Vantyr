import { Header, SpaceBetween, Button, ButtonDropdown } from "../ui/console";

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
  onDeleteSelected?: () => void;
  onBulkAddToGroup?: () => void;
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
  const bulkItems: any[] = [
    ...(selectedHasOffline ? [{ id: "wake", text: `Wake offline (${selectedOfflineCount})` }] : []),
    ...(selectedHasOnline
      ? [
          { id: "script", text: `Run script (${selectedOnlineCount})` },
          { id: "lock", text: `Lock (${selectedOnlineCount})` },
          { id: "restart", text: `Restart (${selectedOnlineCount})` },
          { id: "shutdown", text: `Shutdown (${selectedOnlineCount})` },
        ]
      : []),
    ...(onBulkAddToGroup != null ? [{ id: "add_group", text: "Add selected to group" }] : []),
    ...(onDeleteSelected != null ? [{ id: "delete", text: "Delete selected (forget)" }] : []),
  ];

  const onBulkActionClick = ({ detail }: any) => {
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
