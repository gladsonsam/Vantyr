import { useEffect, useMemo, useRef, useState } from "react";
import { useServerVersionPayload } from "../../lib/serverVersionStore";
import { Alert, Box, Button, ColumnLayout, Container, Header, SpaceBetween, Spinner, StatusIndicator } from "../ui/console";
import type { Agent, AgentInfo } from "../../lib/types";
import { ConnectionStatus } from "../common/StatusIndicator";
import { api } from "../../lib/api";

interface GeneralConfigProps {
  agent: Agent;
  info: AgentInfo | null;
  /** Called when fresh agent info is loaded from the server (e.g. after Update now). */
  onAgentInfoRefreshed?: (info: AgentInfo | null) => void;
}

export function GeneralConfig({ agent, info, onAgentInfoRefreshed }: GeneralConfigProps) {
  const agentVersion = info?.agent_version || "—";
  const versionPayload = useServerVersionPayload();
  const [versionFetchSettled, setVersionFetchSettled] = useState(versionPayload !== null);
  const [updateNow, setUpdateNow] = useState(false);
  const [updateNowErr, setUpdateNowErr] = useState<string | null>(null);
  const [updateNowOk, setUpdateNowOk] = useState<string | null>(null);
  const pollSessionRef = useRef(0);
  const didKickOffFetchRef = useRef(false);

  useEffect(() => {
    return () => {
      pollSessionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    // If another part of the dashboard already fetched versions (e.g. Settings → "Check GitHub now"),
    // don't issue another request here that could overwrite the shared store.
    if (versionPayload !== null) {
      setVersionFetchSettled(true);
      return;
    }
    if (didKickOffFetchRef.current) return;
    didKickOffFetchRef.current = true;

    let cancelled = false;
    api
      .settingsVersionGet({ nocache: true })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setVersionFetchSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [versionPayload]);

  const latestAgentVersion = versionPayload?.latest_agent_version ?? null;
  const versionsLoad = versionPayload === null && !versionFetchSettled;

  const normalizeVersion = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    if (!s || s === "—") return null;
    return s.replace(/^v/i, "");
  };

  const installed = useMemo(() => normalizeVersion(agentVersion), [agentVersion]);
  const latest = useMemo(() => normalizeVersion(latestAgentVersion), [latestAgentVersion]);
  const isOutOfDate = useMemo(() => {
    if (!installed || !latest) return false;
    return installed !== latest;
  }, [installed, latest]);

  const triggerUpdateNow = () => {
    setUpdateNowErr(null);
    setUpdateNowOk(null);
    setUpdateNow(true);
    const baseline = normalizeVersion(agentVersion);
    pollSessionRef.current += 1;
    const session = pollSessionRef.current;
    const targetLatest = normalizeVersion(latestAgentVersion);

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const pollUntilVersionReflects = async () => {
      const deadline = Date.now() + 120_000;
      const tryFetch = async (): Promise<boolean> => {
        const { info: next } = await api.agentInfo(agent.id);
        onAgentInfoRefreshed?.(next ?? null);
        const nowV = normalizeVersion(next?.agent_version);
        if (nowV && targetLatest && nowV === targetLatest) return true;
        if (nowV && baseline && nowV !== baseline) return true;
        return false;
      };
      let first = true;
      while (Date.now() < deadline && pollSessionRef.current === session) {
        await sleep(first ? 1000 : 2500);
        first = false;
        if (pollSessionRef.current !== session) return;
        try {
          if (await tryFetch()) return;
        } catch {
          /* keep polling */
        }
      }
    };

    api
      .agentUpdateNow(agent.id)
      .then(() => {
        setUpdateNowOk(
          "Update triggered. If the agent is connected, it will download and install the latest release.",
        );
        void pollUntilVersionReflects();
      })
      .catch((e) => setUpdateNowErr(String(e)))
      .finally(() => setUpdateNow(false));
  };

  return (
    <Container
      header={
        <Header variant="h2">
          General configuration
        </Header>
      }
    >
      <ColumnLayout columns={3} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">Agent</Box>
          <div>{agent.name}</div>
        </div>
        <div>
          <Box variant="awsui-key-label">Connection</Box>
          <ConnectionStatus
            connected={agent.online}
            lastSeen={agent.last_seen ? new Date(agent.last_seen) : null}
          />
        </div>
        <div>
          <Box variant="awsui-key-label">Agent version</Box>
          <SpaceBetween size="xs">
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <div>{agentVersion}</div>
              {versionsLoad ? (
                <Spinner size="normal" />
              ) : isOutOfDate ? (
                <StatusIndicator type="warning">Update available</StatusIndicator>
              ) : latest ? (
                <StatusIndicator type="success">Up to date</StatusIndicator>
              ) : (
                <StatusIndicator type="pending">Unknown</StatusIndicator>
              )}
            </SpaceBetween>

            {isOutOfDate && (
              <Alert type="warning">
                New agent version <b>{latest}</b> is available.
              </Alert>
            )}

            {updateNowErr && (
              <Alert type="error" dismissible onDismiss={() => setUpdateNowErr(null)}>
                {updateNowErr}
              </Alert>
            )}
            {updateNowOk && (
              <Alert type="success" dismissible onDismiss={() => setUpdateNowOk(null)}>
                {updateNowOk}
              </Alert>
            )}

            <Button
              variant={isOutOfDate ? "primary" : "normal"}
              disabled={!agent.online || updateNow || !isOutOfDate}
              loading={updateNow}
              onClick={triggerUpdateNow}
            >
              Update now
            </Button>
            {!agent.online && (
              <Box fontSize="body-s" color="text-body-secondary">
                Agent is offline.
              </Box>
            )}
          </SpaceBetween>
        </div>
      </ColumnLayout>
    </Container>
  );
}
