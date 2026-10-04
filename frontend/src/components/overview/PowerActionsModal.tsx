import { Modal, Box, SpaceBetween, Button, StatusPill } from "../ui/console";
import type { FleetRow } from "./types";

interface PowerActionsModalProps {
  visible: boolean;
  onDismiss: () => void;
  modalRow: FleetRow | null;
  onBatchWake: (agentIds: string[]) => void;
  onBatchLock: (agentIds: string[]) => void;
  onBatchRestart: (agentIds: string[]) => void;
  onBatchShutdown: (agentIds: string[]) => void;
  onDeleteAgent?: (agentId: string) => void;
  deleteBusy?: boolean;
  canOperate?: boolean;
}

export function PowerActionsModal({
  visible,
  onDismiss,
  modalRow,
  onBatchWake,
  onBatchLock,
  onBatchRestart,
  onBatchShutdown,
  onDeleteAgent,
  deleteBusy,
  canOperate = true,
}: PowerActionsModalProps) {
  return (
    <Modal
      visible={visible}
      onDismiss={() => {
        onDismiss();
      }}
      header="Power actions"
      footer={
        <Box float="right">
          <Button variant="link" onClick={onDismiss}>
            Close
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {!canOperate && (
          <Box color="text-body-secondary">
            View-only — an operator role is required for power actions.
          </Box>
        )}
        <div className="vantyr-power-modal-head" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <strong>{modalRow?.displayName ?? "Agent"}</strong>
          {modalRow ? <StatusPill status={modalRow.status}>{modalRow.statusLabel}</StatusPill> : null}
        </div>

        {canOperate && (modalRow?.online ? (
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              iconName="lock-private"
              onClick={() => {
                if (!modalRow) return;
                onDismiss();
                onBatchLock([modalRow.id]);
              }}
            >
              Lock
            </Button>
            <Button
              iconName="redo"
              onClick={() => {
                if (!modalRow) return;
                onDismiss();
                onBatchRestart([modalRow.id]);
              }}
            >
              Restart
            </Button>
            <Button
              iconName="close"
              variant="primary"
              onClick={() => {
                if (!modalRow) return;
                onDismiss();
                onBatchShutdown([modalRow.id]);
              }}
            >
              Shutdown
            </Button>
          </SpaceBetween>
        ) : (
          <SpaceBetween size="s">
            <Box color="text-body-secondary">This agent is offline. Wake-on-LAN is available when configured and reachable on the LAN.</Box>
            <div>
              <Button
                iconName="status-stopped"
                variant="primary"
                onClick={() => {
                  if (!modalRow) return;
                  onDismiss();
                  onBatchWake([modalRow.id]);
                }}
              >
                Wake on LAN
              </Button>
            </div>
          </SpaceBetween>
        ))}

        {onDeleteAgent && modalRow && (
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--line)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div>
              <Button iconName="close" disabled={deleteBusy} onClick={() => onDeleteAgent(modalRow.id)}>
                Remove device…
              </Button>
            </div>
          </div>
        )}
      </SpaceBetween>
    </Modal>
  );
}
