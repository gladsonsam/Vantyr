import { useState } from "react";
import { SpaceBetween, Modal, FormField, Input, Box, Button, Table, ColumnLayout } from "../ui/console";
import type { DashboardIdentity } from "../../lib/types";

export interface OidcIdentitiesModalProps {
  visible: boolean;
  onDismiss: () => void;
  username: string;
  isNarrow: boolean;
  identities: DashboardIdentity[] | null;
  onLink: (identity: { issuer: string; subject: string }) => Promise<void>;
  onUnlink: (identityId: number) => Promise<void>;
}

export function OidcIdentitiesModal({
  visible,
  onDismiss,
  username,
  isNarrow,
  identities,
  onLink,
  onUnlink,
}: OidcIdentitiesModalProps) {
  const [identityLink, setIdentityLink] = useState({ issuer: "", subject: "" });
  const [loading, setLoading] = useState(false);

  const handleLink = async () => {
    setLoading(true);
    try {
      await onLink({
        issuer: identityLink.issuer.trim(),
        subject: identityLink.subject.trim(),
      });
      setIdentityLink({ issuer: "", subject: "" });
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
      header={`Linked identities: ${username}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={!identityLink.issuer.trim() || !identityLink.subject.trim()}
              loading={loading}
              onClick={handleLink}
            >
              Link identity
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <ColumnLayout columns={isNarrow ? 1 : 2}>
          <FormField label="Issuer">
            <Input
              value={identityLink.issuer}
              onChange={({ detail }) => setIdentityLink((p) => ({ ...p, issuer: detail.value }))}
              disabled={loading}
            />
          </FormField>
          <FormField label="Subject (sub)">
            <Input
              value={identityLink.subject}
              onChange={({ detail }) => setIdentityLink((p) => ({ ...p, subject: detail.value }))}
              disabled={loading}
            />
          </FormField>
        </ColumnLayout>
        {identities && identities.length > 0 ? (
          <Table
            items={identities}
            wrapLines
            columnDefinitions={[
              {
                id: "issuer",
                header: "Issuer",
                cell: (i: DashboardIdentity) => <Box className="vantyr-wrap-anywhere">{i.issuer}</Box>,
              },
              {
                id: "subject",
                header: "Subject",
                cell: (i: DashboardIdentity) => <Box className="vantyr-wrap-anywhere">{i.subject}</Box>,
              },
              {
                id: "unlink",
                header: "",
                cell: (i: DashboardIdentity) => (
                  <Button
                    variant="icon"
                    iconName="close"
                    ariaLabel="Unlink identity"
                    onClick={() => onUnlink(i.id)}
                  />
                ),
              },
            ]}
            variant="embedded"
          />
        ) : (
          <Box color="text-body-secondary">No linked identities.</Box>
        )}
      </SpaceBetween>
    </Modal>
  );
}

