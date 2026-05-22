import { useEffect, useMemo, useState } from "react";
import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";

export type PendingAgentClaim = {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  requested_name: string;
  hostname: string | null;
  os?: string | null;
  agent_version: string | null;
  client_ip: string | null;
  discovered_server?: string | null;
  created_at: string;
};

interface PendingAgentApprovalsProps {
  claims: PendingAgentClaim[];
  loading?: boolean;
  lastRefreshedAt?: Date | null;
  onRefresh?: () => void | Promise<void>;
  onApprove: (claim: PendingAgentClaim, agentName: string) => void | Promise<void>;
  onReject: (claim: PendingAgentClaim) => void | Promise<void>;
}

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatRefreshedAt(value: Date | null | undefined): string {
  if (!value) return "Waiting for first refresh";
  return `Updated ${value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function PendingAgentApprovals({
  claims,
  loading = false,
  lastRefreshedAt = null,
  onRefresh,
  onApprove,
  onReject,
}: PendingAgentApprovalsProps) {
  const pendingClaims = useMemo(() => claims.filter((claim) => claim.status === "pending"), [claims]);
  const [approveClaim, setApproveClaim] = useState<PendingAgentClaim | null>(null);
  const [rejectClaim, setRejectClaim] = useState<PendingAgentClaim | null>(null);
  const [agentName, setAgentName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    if (approveClaim) setAgentName(approveClaim.requested_name);
  }, [approveClaim]);

  const closeDialogs = () => {
    if (actionLoading) return;
    setApproveClaim(null);
    setRejectClaim(null);
    setActionError(null);
  };

  const confirmApprove = async () => {
    if (!approveClaim) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await onApprove(approveClaim, agentName.trim() || approveClaim.requested_name);
      setApproveClaim(null);
      setActionError(null);
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message ?? e));
    } finally {
      setActionLoading(false);
    }
  };

  const confirmReject = async () => {
    if (!rejectClaim) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await onReject(rejectClaim);
      setRejectClaim(null);
      setActionError(null);
    } catch (e: unknown) {
      setActionError(String((e as { message?: string })?.message ?? e));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <>
      <section className="sentinel-pending-agents" aria-labelledby="sentinel-pending-agents-heading">
        <div className="sentinel-pending-agents__header">
          <div>
            <Box variant="h3">
              <span id="sentinel-pending-agents-heading">Pending agents</span>
              <Box variant="span" color="text-body-secondary">
                {" "}
                ({pendingClaims.length})
              </Box>
            </Box>
            <Box color="text-body-secondary" fontSize="body-s">
              {loading ? "Refreshing..." : formatRefreshedAt(lastRefreshedAt)}
            </Box>
          </div>
          {onRefresh ? (
            <Button iconName="refresh" onClick={() => void onRefresh()} loading={loading}>
              Refresh
            </Button>
          ) : null}
        </div>

        {pendingClaims.length === 0 ? (
          <div className="sentinel-pending-agents__empty">
            <StatusIndicator type="info">No devices are waiting for approval.</StatusIndicator>
          </div>
        ) : (
          <div className="sentinel-pending-agents__list">
            {pendingClaims.map((claim) => {
              const firstSeen = new Date(claim.created_at);
              return (
                <article className="sentinel-pending-agent" key={claim.id}>
                  <div className="sentinel-pending-agent__main">
                    <div className="sentinel-pending-agent__title-row">
                      <div className="sentinel-pending-agent__name">{claim.requested_name}</div>
                      <StatusIndicator type="pending">Pending</StatusIndicator>
                    </div>
                    <dl className="sentinel-pending-agent__meta">
                      <div>
                        <dt>Host</dt>
                        <dd>{claim.hostname ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>IP</dt>
                        <dd>{claim.client_ip ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Agent</dt>
                        <dd>{claim.agent_version ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>First seen</dt>
                        <dd>
                          <time dateTime={claim.created_at} title={firstSeen.toLocaleString()}>
                            {formatRelativeTime(claim.created_at)}
                          </time>
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="sentinel-pending-agent__actions">
                    <Button onClick={() => setApproveClaim(claim)}>Approve device</Button>
                    <Button onClick={() => setRejectClaim(claim)}>Reject</Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <Modal
        visible={approveClaim !== null}
        onDismiss={closeDialogs}
        header="Approve device"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={closeDialogs} disabled={actionLoading}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void confirmApprove()} loading={actionLoading}>
                Approve device
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {approveClaim ? (
            <>
              <FormField label="Device name" description="This is the name Sentinel will show in the dashboard.">
                <Input value={agentName} onChange={({ detail }) => setAgentName(detail.value)} autoFocus />
              </FormField>
              <div className="sentinel-pending-agent-dialog-summary">
                <div>
                  <dt>Requested</dt>
                  <dd>{approveClaim.requested_name}</dd>
                </div>
                <div>
                  <dt>Host</dt>
                  <dd>{approveClaim.hostname ?? "-"}</dd>
                </div>
                <div>
                  <dt>IP</dt>
                  <dd>{approveClaim.client_ip ?? "-"}</dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>{approveClaim.agent_version ?? "-"}</dd>
                </div>
              </div>
            </>
          ) : null}
          {actionError ? (
            <Alert type="error" dismissible onDismiss={() => setActionError(null)}>
              {actionError}
            </Alert>
          ) : null}
        </SpaceBetween>
      </Modal>

      <Modal
        visible={rejectClaim !== null}
        onDismiss={closeDialogs}
        header="Reject device"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={closeDialogs} disabled={actionLoading}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void confirmReject()} loading={actionLoading}>
                Reject
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            Reject{" "}
            <Box variant="strong" display="inline">
              {rejectClaim?.requested_name ?? "this device"}
            </Box>
            ? The agent will need to request access again before it can connect.
          </Box>
          {rejectClaim ? (
            <div className="sentinel-pending-agent-dialog-summary">
              <div>
                <dt>Host</dt>
                <dd>{rejectClaim.hostname ?? "-"}</dd>
              </div>
              <div>
                <dt>IP</dt>
                <dd>{rejectClaim.client_ip ?? "-"}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{rejectClaim.agent_version ?? "-"}</dd>
              </div>
            </div>
          ) : null}
          {actionError ? (
            <Alert type="error" dismissible onDismiss={() => setActionError(null)}>
              {actionError}
            </Alert>
          ) : null}
        </SpaceBetween>
      </Modal>
    </>
  );
}
