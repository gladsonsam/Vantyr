import { useCallback, useEffect, useState } from "react";
import Modal from "@cloudscape-design/components/modal";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Alert from "@cloudscape-design/components/alert";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Table from "@cloudscape-design/components/table";
import { api } from "../../lib/api";
import { formatEnrollmentOtp6 } from "../../lib/formatEnrollmentCode";

export type AgentSetupHints = {
  mdns: "advertising" | "disabled_by_env" | "unavailable_no_wss_url";
  agent_wss_url: string | null;
  mdns_port: number;
};

interface AddAgentModalProps {
  visible: boolean;
  onDismiss: () => void;
}

function hintsInstruction(h: AgentSetupHints): { type: "info" | "warning"; header: string; body: string } {
  if (h.mdns === "advertising") {
    return {
      type: "info",
      header: "LAN discovery is on",
      body: `This server advertises Sentinel on the LAN (mDNS service _sentinel._tcp, port ${h.mdns_port}). On the Windows PC, open agent settings (Ctrl+Shift+F12): use Discover server, or paste the WebSocket URL below, then Request access.`,
    };
  }
  if (h.mdns === "disabled_by_env") {
    return {
      type: "warning",
      header: "LAN discovery is off",
      body:
        "mDNS is disabled on this server (SENTINEL_MDNS=0 or SENTINEL_MDNS_DISABLE=1). Enter the WebSocket URL manually on the agent. If no URL appears below, set PUBLIC_BASE_URL or SENTINEL_MDNS_WSS_URL on the server.",
    };
  }
  return {
    type: "warning",
    header: "WebSocket URL not configured",
    body:
      "Set PUBLIC_BASE_URL=https://… or SENTINEL_MDNS_WSS_URL=wss://…/ws/agent on the server, then reopen this dialog. Until then, use the wss:// URL that matches how you reach this dashboard.",
  };
}

export function AddAgentModal({ visible, onDismiss }: AddAgentModalProps) {
  const [hints, setHints] = useState<AgentSetupHints | null>(null);
  const [hintsErr, setHintsErr] = useState<string | null>(null);
  const [hintsLoading, setHintsLoading] = useState(false);

  const [enrollUses, setEnrollUses] = useState(1);
  const [enrollExpireHours, setEnrollExpireHours] = useState("");
  const [enrollNote, setEnrollNote] = useState("");
  const [enrollLoading, setEnrollLoading] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollResult, setEnrollResult] = useState<{
    token: string;
    uses: number;
    expires_at: string | null;
  } | null>(null);
  const [claims, setClaims] = useState<
    {
      id: string;
      status: "pending" | "approved" | "rejected" | "expired";
      requested_name: string;
      hostname: string | null;
      os: string | null;
      agent_version: string | null;
      client_ip: string | null;
      discovered_server: string | null;
      created_at: string;
    }[]
  >([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsError, setClaimsError] = useState<string | null>(null);

  const loadClaims = useCallback(async () => {
    setClaimsLoading(true);
    setClaimsError(null);
    try {
      const r = await api.listAgentEnrollmentClaims();
      setClaims(r.claims ?? []);
    } catch (e: unknown) {
      setClaimsError(String((e as { message?: string })?.message ?? e));
    } finally {
      setClaimsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setEnrollResult(null);
    setEnrollError(null);
    setHintsLoading(true);
    setHintsErr(null);
    void api
      .getAgentSetupHints()
      .then((r) => {
        setHints(r);
      })
      .catch((e: unknown) => {
        setHints(null);
        setHintsErr(String((e as { message?: string })?.message ?? e));
      })
      .finally(() => setHintsLoading(false));
    void loadClaims();
  }, [loadClaims, visible]);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => void loadClaims(), 5000);
    return () => window.clearInterval(id);
  }, [loadClaims, visible]);

  const generateEnrollmentToken = async () => {
    setEnrollLoading(true);
    setEnrollError(null);
    try {
      const uses = Math.max(1, Math.min(100_000, Number(enrollUses) || 1));
      const body: {
        uses: number;
        expires_in_hours?: number;
        note?: string;
      } = { uses };
      const rawH = enrollExpireHours.trim();
      if (rawH !== "") {
        const h = Math.max(1, Math.min(24 * 365, parseInt(rawH, 10) || 0));
        if (h > 0) body.expires_in_hours = h;
      }
      if (enrollNote.trim()) body.note = enrollNote.trim();
      const r = await api.createAgentEnrollmentToken(body);
      setEnrollResult({
        token: r.enrollment_token,
        uses: r.uses,
        expires_at: r.expires_at,
      });
      await loadClaims();
    } catch (e: unknown) {
      setEnrollError(String((e as { message?: string })?.message ?? e));
      setEnrollResult(null);
    } finally {
      setEnrollLoading(false);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const instruct = hints ? hintsInstruction(hints) : null;
  const pendingClaims = claims.filter((c) => c.status === "pending");

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      size="large"
      header="Add agent"
      footer={
        <Box float="right">
          <Button variant="link" onClick={onDismiss}>
            Close
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {hintsLoading ? (
          <Box color="text-body-secondary" fontSize="body-s">
            Loading server hints…
          </Box>
        ) : null}
        {hintsErr ? (
          <Alert type="error" dismissible onDismiss={() => setHintsErr(null)}>
            {hintsErr}
          </Alert>
        ) : null}
        {instruct ? (
          <Alert type={instruct.type} header={instruct.header}>
            {instruct.body}
          </Alert>
        ) : null}
        {hints?.agent_wss_url ? (
          <SpaceBetween size="xs">
            <Box fontSize="body-s" color="text-body-secondary">
              Agent WebSocket URL
            </Box>
            <Box variant="code" fontSize="body-m">
              {hints.agent_wss_url}
            </Box>
            <Box>
              <Button onClick={() => void copyText(hints.agent_wss_url!)}>Copy WebSocket URL</Button>
            </Box>
          </SpaceBetween>
        ) : null}

        <Box fontSize="body-s" color="text-body-secondary">
          Generates a <Box variant="strong">6-digit</Box> pairing code. On the PC use <Box variant="strong">Request access</Box>{" "}
          in the agent settings. Codes create pending agents and expire after 10 minutes by default.
        </Box>
        <ColumnLayout columns={3} variant="text-grid">
          <FormField label="Uses" description="Pending claims per code.">
            <Input
              type="number"
              inputMode="numeric"
              value={String(enrollUses)}
              onChange={({ detail }) =>
                setEnrollUses(Math.max(1, Math.min(100_000, Number(detail.value) || 1)))
              }
            />
          </FormField>
          <FormField label="Expires in (hours)" description="Leave empty for no expiry.">
            <Input
              value={enrollExpireHours}
              onChange={({ detail }) => setEnrollExpireHours(detail.value)}
              placeholder="e.g. 72"
            />
          </FormField>
          <FormField label="Note (optional)" description="Stored with the token record.">
            <Input value={enrollNote} onChange={({ detail }) => setEnrollNote(detail.value)} />
          </FormField>
        </ColumnLayout>
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="primary" onClick={() => void generateEnrollmentToken()} loading={enrollLoading}>
            Generate code
          </Button>
          {enrollResult ? (
            <Button onClick={() => void copyText(enrollResult.token)}>Copy code</Button>
          ) : null}
        </SpaceBetween>
        {enrollError ? (
          <Alert type="error" dismissible onDismiss={() => setEnrollError(null)}>
            {enrollError}
          </Alert>
        ) : null}
        {enrollResult ? (
          <Alert type="success" header="Pairing code (6 digits)">
            <Box variant="code" fontSize="display-l" margin={{ top: "xs" }} fontWeight="bold">
              {formatEnrollmentOtp6(enrollResult.token)}
            </Box>
            <Box fontSize="body-s" margin={{ top: "s" }} color="text-body-secondary">
              Uses remaining: {enrollResult.uses}
              {enrollResult.expires_at
                ? ` · Expires: ${new Date(enrollResult.expires_at).toLocaleString()}`
                : ""}
            </Box>
          </Alert>
        ) : null}
        <Table
          header={
            <Box variant="h3">
              Pending agents
              <Box variant="span" color="text-body-secondary">
                {" "}
                ({pendingClaims.length})
              </Box>
            </Box>
          }
          items={pendingClaims}
          loading={claimsLoading}
          loadingText="Loading pending agents"
          empty={<Box color="text-body-secondary">No devices are waiting for approval.</Box>}
          columnDefinitions={[
            { id: "name", header: "Requested name", cell: (c) => c.requested_name },
            { id: "host", header: "Hostname", cell: (c) => c.hostname ?? "\u2014" },
            { id: "ip", header: "IP", cell: (c) => c.client_ip ?? "\u2014" },
            { id: "version", header: "Agent", cell: (c) => c.agent_version ?? "\u2014" },
            { id: "created", header: "First seen", cell: (c) => new Date(c.created_at).toLocaleString() },
            {
              id: "actions",
              header: "",
              cell: (c) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => {
                      const agentName = window.prompt("Approve device as:", c.requested_name);
                      if (agentName === null) return;
                      void api
                        .approveAgentEnrollmentClaim(c.id, { agent_name: agentName.trim() || c.requested_name })
                        .then(() => loadClaims())
                        .catch((e: unknown) => setClaimsError(String((e as { message?: string })?.message ?? e)));
                    }}
                  >
                    Approve device
                  </Button>
                  <Button
                    onClick={() => {
                      if (!window.confirm(`Reject ${c.requested_name}?`)) return;
                      void api
                        .rejectAgentEnrollmentClaim(c.id)
                        .then(() => loadClaims())
                        .catch((e: unknown) => setClaimsError(String((e as { message?: string })?.message ?? e)));
                    }}
                  >
                    Reject
                  </Button>
                </SpaceBetween>
              ),
            },
          ]}
        />
        {claimsError ? (
          <Alert type="error" dismissible onDismiss={() => setClaimsError(null)}>
            {claimsError}
          </Alert>
        ) : null}
      </SpaceBetween>
    </Modal>
  );
}
