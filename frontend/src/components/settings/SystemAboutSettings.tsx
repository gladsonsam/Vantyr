import { useState } from "react";
import { Alert, Box, Button, ColumnLayout, Container, ExpandableSection, FormField, Header, SpaceBetween, Table, Toggle } from "../ui/console";

interface StorageTableItem {
  name: string;
  bytes: number;
}

interface StorageUsage {
  database_bytes: number;
  public_tables_bytes: number;
  other_bytes: number;
  tables: StorageTableItem[];
}

interface SystemAboutSettingsProps {
  isAdmin: boolean;
  loadingMeta: boolean;
  storage: StorageUsage | null;
  githubRelease: { tag: string | null; releasesUrl: string } | null;
  githubReleaseLoading: boolean;
  githubReleaseError: string | null;
  agentAutoUpdateEnabled: boolean | null;
  agentAutoUpdateLoadErr: string | null;
  onCheckGithubRelease: (nocache: boolean) => Promise<void>;
  onRefreshMeta: () => Promise<void>;
  onSaveAutoUpdate: (enabled: boolean) => Promise<void>;
}

function formatBytesAdaptive(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "\u2014";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(2)} ${units[idx]}`;
}

export function SystemAboutSettings({
  isAdmin,
  loadingMeta,
  storage,
  githubRelease,
  githubReleaseLoading,
  githubReleaseError,
  agentAutoUpdateEnabled,
  agentAutoUpdateLoadErr,
  onCheckGithubRelease,
  onRefreshMeta,
  onSaveAutoUpdate,
}: SystemAboutSettingsProps) {
  const [autoUpdateSaving, setAutoUpdateSaving] = useState(false);
  const [autoUpdateSaveErr, setAutoUpdateSaveErr] = useState<string | null>(null);

  const handleAutoUpdateChange = async (checked: boolean) => {
    setAutoUpdateSaving(true);
    setAutoUpdateSaveErr(null);
    try {
      await onSaveAutoUpdate(checked);
    } catch (e) {
      setAutoUpdateSaveErr(String(e));
    } finally {
      setAutoUpdateSaving(false);
    }
  };

  return (
    <SpaceBetween size="l">
      {/* Storage usage */}
      <Container
        header={
          <Header
            variant="h2"
            description="Total size is PostgreSQL pg_database_size (entire DB on disk). Expand to see per-table breakdown."
            actions={
              <Button iconName="refresh" onClick={onRefreshMeta} loading={loadingMeta}>
                Refresh usage
              </Button>
            }
          >
            Storage usage
          </Header>
        }
      >
        <SpaceBetween size="m">
          <ColumnLayout columns={3} variant="text-grid">
            <Box>
              <Box>Total database size</Box>
              <div>{storage ? formatBytesAdaptive(storage.database_bytes) : "\u2014"}</div>
            </Box>
            <Box>
              <Box>Public schema</Box>
              <div>{storage ? formatBytesAdaptive(storage.public_tables_bytes) : "\u2014"}</div>
            </Box>
            <Box>
              <Box>Other</Box>
              <div>{storage ? formatBytesAdaptive(storage.other_bytes) : "\u2014"}</div>
            </Box>
          </ColumnLayout>

          <ExpandableSection headerText="Details" defaultExpanded={false}>
            {storage ? (
              <SpaceBetween size="m">
                <Box fontSize="body-s" color="text-body-secondary">
                  {storage.tables.length} relation{storage.tables.length === 1 ? "" : "s"} in{" "}
                  <Box variant="code">public</Box> (partition children are rolled into their parent&apos;s size).
                </Box>
                <Table
                  items={storage.tables}
                  columnDefinitions={[
                    { id: "name", header: "Relation", cell: (item) => item.name },
                    { id: "bytes", header: "Size (with indexes)", cell: (item) => formatBytesAdaptive(item.bytes) },
                  ]}
                  variant="embedded"
                />
              </SpaceBetween>
            ) : (
              <Box color="text-body-secondary">No storage data yet.</Box>
            )}
          </ExpandableSection>
        </SpaceBetween>
      </Container>

      {/* About */}
      <Container
        header={
          <Header variant="h2" description="Tag from the latest GitHub release (same source as server Docker images).">
            About
          </Header>
        }
        footer={
          <Button
            iconName="refresh"
            loading={githubReleaseLoading}
            onClick={() => void onCheckGithubRelease(true)}
          >
            Check GitHub now
          </Button>
        }
      >
        <SpaceBetween size="m">
          {githubReleaseError ? (
            <Box color="text-status-error">{githubReleaseError}</Box>
          ) : null}
          {autoUpdateSaveErr ? (
            <Alert type="error" dismissible onDismiss={() => setAutoUpdateSaveErr(null)}>
              {autoUpdateSaveErr}
            </Alert>
          ) : null}
          {agentAutoUpdateLoadErr ? (
            <Alert type="error">{agentAutoUpdateLoadErr}</Alert>
          ) : agentAutoUpdateEnabled === null && loadingMeta ? (
            <Box color="text-body-secondary">{`Loading agent auto-update policy\u2026`}</Box>
          ) : (
            <FormField
              label="Agent auto updates (global default)"
              description={
                isAdmin
                  ? "When enabled, the server tells connected Windows agents they may check GitHub releases and install updates (policy is pushed over the WebSocket). Operators can still set a per-computer override on each agent's Settings tab."
                  : "Current default policy for Windows agents. Only administrators can change it."
              }
              constraintText={!isAdmin ? "Administrator role required to edit." : undefined}
            >
              <Toggle
                checked={agentAutoUpdateEnabled ?? false}
                disabled={
                  agentAutoUpdateEnabled === null || !isAdmin || autoUpdateSaving || loadingMeta
                }
                onChange={({ detail }) => void handleAutoUpdateChange(detail.checked)}
              >
                Enable agent auto updates by default
              </Toggle>
            </FormField>
          )}
          <Box>
            <Box>Latest GitHub release</Box>
            <div>
              {githubReleaseLoading && githubRelease == null ? `\u2026` : githubRelease?.tag ?? "\u2014"}
            </div>
            {githubRelease?.releasesUrl ? (
              <Box fontSize="body-s" margin={{ top: "xs" }} color="text-body-secondary">
                <a href={githubRelease.releasesUrl} target="_blank" rel="noopener noreferrer">
                  Open releases on GitHub
                </a>
              </Box>
            ) : null}
          </Box>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
