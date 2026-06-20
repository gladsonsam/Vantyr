import { useState } from "react";
import { Alert, Box, Button, ColumnLayout, Container, FormField, Header, Input, SpaceBetween } from "../ui/console";

interface SecuritySettingsProps {
  isAdmin: boolean;
  loadingMeta: boolean;
  localUiPasswordSet: boolean | null;
  onSavePassword: (password: string | null) => Promise<void>;
}

export function SecuritySettings({
  isAdmin,
  loadingMeta,
  localUiPasswordSet,
  onSavePassword,
}: SecuritySettingsProps) {
  const [localUiPwd, setLocalUiPwd] = useState("");
  const [localUiPwd2, setLocalUiPwd2] = useState("");
  const [localUiSaveErr, setLocalUiSaveErr] = useState<string | null>(null);
  const [localUiSaveOk, setLocalUiSaveOk] = useState<string | null>(null);
  const [localUiSaving, setLocalUiSaving] = useState(false);

  const handleSave = async (password: string | null) => {
    setLocalUiSaving(true);
    setLocalUiSaveErr(null);
    setLocalUiSaveOk(null);
    try {
      await onSavePassword(password);
      setLocalUiPwd("");
      setLocalUiPwd2("");
      setLocalUiSaveOk(password ? "Saved. Connected agents will receive the new lock password." : "Removed.");
    } catch (e) {
      setLocalUiSaveErr(String(e));
    } finally {
      setLocalUiSaving(false);
    }
  };

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Default lock for the Windows agent's local Settings window. Agents may override per-device."
        >
          Agent local UI password (global default)
        </Header>
      }
    >
      <SpaceBetween size="m">
        {localUiSaveErr ? (
          <Alert type="error" dismissible onDismiss={() => setLocalUiSaveErr(null)}>
            {localUiSaveErr}
          </Alert>
        ) : null}
        {localUiSaveOk ? (
          <Alert type="success" dismissible onDismiss={() => setLocalUiSaveOk(null)}>
            {localUiSaveOk}
          </Alert>
        ) : null}

        {localUiPasswordSet === null && loadingMeta ? (
          <Box color="text-body-secondary">{`Loading\u2026`}</Box>
        ) : (
          <Box fontSize="body-s" color="text-body-secondary">
            Status:{" "}
            {localUiPasswordSet ? (
              <strong>Password is set</strong>
            ) : (
              <strong>No password</strong>
            )}
          </Box>
        )}

        <ColumnLayout columns={2}>
          <FormField
            label="New password"
            description="Leave blank to remove the global password."
            constraintText={!isAdmin ? "Administrator role required to edit." : undefined}
          >
            <Input
              type="password"
              value={localUiPwd}
              disabled={!isAdmin || localUiSaving}
              onChange={({ detail }) => setLocalUiPwd(detail.value)}
            />
          </FormField>
          <FormField label="Confirm password">
            <Input
              type="password"
              value={localUiPwd2}
              disabled={!isAdmin || localUiSaving}
              onChange={({ detail }) => setLocalUiPwd2(detail.value)}
            />
          </FormField>
        </ColumnLayout>

        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant="primary"
            loading={localUiSaving}
            disabled={!isAdmin || localUiSaving}
            onClick={() => {
              const a = localUiPwd.trim();
              const b = localUiPwd2.trim();
              setLocalUiSaveErr(null);
              setLocalUiSaveOk(null);
              if (a !== b) {
                setLocalUiSaveErr("Passwords do not match.");
                return;
              }
              if (a.length > 0 && a.length < 4) {
                setLocalUiSaveErr("Use at least 4 characters, or leave both fields empty to remove the password.");
                return;
              }
              void handleSave(a.length ? a : null);
            }}
          >
            Save
          </Button>
          <Button
            variant="link"
            loading={localUiSaving}
            disabled={!isAdmin || localUiSaving}
            onClick={() => {
              setLocalUiPwd("");
              setLocalUiPwd2("");
              void handleSave(null);
            }}
          >
            Remove password
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}
