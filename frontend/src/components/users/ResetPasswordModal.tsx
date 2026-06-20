import { useState } from "react";
import { SpaceBetween, Modal, FormField, Input, Box, Button } from "../ui/console";

export interface ResetPasswordModalProps {
  visible: boolean;
  onDismiss: () => void;
  username: string;
  onConfirm: (password: string) => Promise<void>;
}

export function ResetPasswordModal({
  visible,
  onDismiss,
  username,
  onConfirm,
}: ResetPasswordModalProps) {
  const [pwValue, setPwValue] = useState("");
  const [loading, setLoading] = useState(false);

  const [prevVisible, setPrevVisible] = useState(false);

  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setPwValue("");
    }
  }

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm(pwValue);
      onDismiss();
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={`Reset password: ${username}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={loading}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pwValue.length < 6}
              loading={loading}
              onClick={handleConfirm}
            >
              Set password
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <FormField label="New password">
        <Input
          type="password"
          value={pwValue}
          onChange={({ detail }) => setPwValue(detail.value)}
          disabled={loading}
        />
      </FormField>
    </Modal>
  );
}
