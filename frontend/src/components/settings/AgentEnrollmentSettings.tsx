import { useState, useMemo } from "react";
import { Alert, Box, Button, ColumnLayout, Container, ExpandableSection, FormField, Header, Input, SpaceBetween, Table } from "../ui/console";
import { PendingAgentApprovals, type PendingAgentClaim } from "../overview/PendingAgentApprovals";
import { formatEnrollmentOtp6 } from "../../lib/formatEnrollmentCode";

interface EnrollmentToken {
  id: string;
  uses_remaining: number;
  created_at: string;
  expires_at: string | null;
  note: string | null;
  used_count: number;
  last_used_at: string | null;
}

interface AgentEnrollmentSettingsProps {
  isAdmin: boolean;
  enrollClaims: PendingAgentClaim[];
  enrollClaimsLoading: boolean;
  enrollClaimsLoadedAt: Date | null;
  onRefreshClaims: () => Promise<void>;
  onApproveClaim: (claim: PendingAgentClaim, agentName: string) => Promise<void>;
  onRejectClaim: (claim: PendingAgentClaim) => Promise<void>;

  enrollTokens: EnrollmentToken[];
  enrollTokensLoading: boolean;
  enrollTokensError: string | null;
  setEnrollTokensError: (err: string | null) => void;
  loadEnrollmentTokens: () => Promise<void>;

  onGenerateToken: (body: { uses: number; expires_in_hours?: number; note?: string }) => Promise<{ enrollment_token: string; uses: number; expires_at: string | null }>;
  onRevokeToken: (id: string) => Promise<void>;
  onRevokeAllTokens: () => Promise<void>;
  onListTokenUses: (id: string) => Promise<{ used_at: string; agent_name: string; agent_id: string | null }[]>;
}

export function AgentEnrollmentSettings({
  isAdmin,
  enrollClaims,
  enrollClaimsLoading,
  enrollClaimsLoadedAt,
  onRefreshClaims,
  onApproveClaim,
  onRejectClaim,
  enrollTokens,
  enrollTokensLoading,
  enrollTokensError,
  setEnrollTokensError,
  loadEnrollmentTokens,
  onGenerateToken,
  onRevokeToken,
  onRevokeAllTokens,
  onListTokenUses,
}: AgentEnrollmentSettingsProps) {
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
  const [enrollCopied, setEnrollCopied] = useState(false);

  const [tokenUses, setTokenUses] = useState<Record<string, { loading: boolean; error: string | null; rows: { used_at: string; agent_name: string; agent_id: string | null }[] }>>(
    {},
  );

  const handleGenerate = async () => {
    setEnrollLoading(true);
    setEnrollError(null);
    try {
      const uses = Math.max(1, Math.min(100_000, Number(enrollUses) || 1));
      const body: { uses: number; expires_in_hours?: number; note?: string } = { uses };
      const rawH = enrollExpireHours.trim();
      if (rawH !== "") {
        const h = Math.max(1, Math.min(24 * 365, parseInt(rawH, 10) || 0));
        if (h > 0) body.expires_in_hours = h;
      }
      if (enrollNote.trim()) body.note = enrollNote.trim();
      const r = await onGenerateToken(body);
      setEnrollResult({
        token: r.enrollment_token,
        uses: r.uses,
        expires_at: r.expires_at,
      });
      await loadEnrollmentTokens();
      await onRefreshClaims();
    } catch (e: unknown) {
      setEnrollError(String((e as { message?: string })?.message ?? e));
      setEnrollResult(null);
    } finally {
      setEnrollLoading(false);
    }
  };

  const copyEnrollmentToken = async () => {
    if (!enrollResult?.token) return;
    try {
      await navigator.clipboard.writeText(enrollResult.token);
      setEnrollCopied(true);
      window.setTimeout(() => setEnrollCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const tokenColumns = useMemo(
    () => [
      {
        id: "created_at",
        header: "Created",
        cell: (t: EnrollmentToken) => new Date(t.created_at).toLocaleString(),
      },
      {
        id: "expires_at",
        header: "Expires",
        cell: (t: EnrollmentToken) =>
          t.expires_at ? new Date(t.expires_at).toLocaleString() : "\u2014",
      },
      {
        id: "uses_remaining",
        header: "Uses left",
        cell: (t: EnrollmentToken) => String(t.uses_remaining ?? 0),
      },
      {
        id: "used_count",
        header: "Used",
        cell: (t: EnrollmentToken) => String(t.used_count ?? 0),
      },
      {
        id: "last_used_at",
        header: "Last used",
        cell: (t: EnrollmentToken) =>
          t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "\u2014",
      },
      {
        id: "note",
        header: "Note",
        cell: (t: EnrollmentToken) => (t.note?.trim() ? t.note : "\u2014"),
      },
      {
        id: "actions",
        header: "",
        cell: (t: EnrollmentToken) => (
          <SpaceBetween direction="horizontal" size="xs">
            {(t.used_count ?? 0) > 0 ? (
              <Button
                onClick={() => {
                  const cur = tokenUses[t.id];
                  if (cur?.rows?.length || cur?.loading) return;
                  setTokenUses((prev) => ({ ...prev, [t.id]: { loading: true, error: null, rows: [] } }));
                  void onListTokenUses(t.id)
                    .then((rows) => {
                      setTokenUses((prev) => ({
                        ...prev,
                        [t.id]: { loading: false, error: null, rows },
                      }));
                    })
                    .catch((e: unknown) => {
                      setTokenUses((prev) => ({
                        ...prev,
                        [t.id]: {
                          loading: false,
                          error: String((e as { message?: string })?.message ?? e),
                          rows: [],
                        },
                      }));
                    });
                }}
              >
                View uses
              </Button>
            ) : null}
            {(t.uses_remaining ?? 0) > 0 ? (
              <Button
                onClick={() => {
                  if (!confirm("Revoke this pairing code? It will become unusable.")) return;
                  void onRevokeToken(t.id)
                    .then(() => loadEnrollmentTokens())
                    .catch((e: unknown) => setEnrollTokensError(String((e as { message?: string })?.message ?? e)));
                }}
              >
                Revoke
              </Button>
            ) : null}
          </SpaceBetween>
        ),
      },
    ],
    [loadEnrollmentTokens, tokenUses, onListTokenUses, onRevokeToken, setEnrollTokensError],
  );

  if (!isAdmin) return null;

  return (
    <ExpandableSection
      defaultExpanded={false}
      headerText="Agent enrollment"
      headerDescription="Create pairing codes and approve pending agents."
    >
      <SpaceBetween size="m">
        <Box fontSize="body-s" color="text-body-secondary">
          On the PC, open agent settings (Ctrl+Shift+F12), enter the WebSocket URL and the six digits, then{" "}
          <Box variant="strong" display="inline">
            Request access
          </Box>
          . Codes create pending agents; approving a claim issues the per-device token.
        </Box>
        <SpaceBetween size="s">
          <PendingAgentApprovals
            claims={enrollClaims}
            loading={enrollClaimsLoading}
            lastRefreshedAt={enrollClaimsLoadedAt}
            onRefresh={onRefreshClaims}
            onApprove={onApproveClaim}
            onReject={onRejectClaim}
          />
        </SpaceBetween>
        <ColumnLayout columns={3} variant="text-grid">
          <FormField label="Uses" description="How many claims can use this code.">
            <Input
              type="number"
              inputMode="numeric"
              value={String(enrollUses)}
              onChange={({ detail }) =>
                setEnrollUses(Math.max(1, Math.min(100_000, Number(detail.value) || 1)))
              }
            />
          </FormField>
          <FormField
            label="Expires in (hours)"
            description="Leave empty for 10 minutes."
          >
            <Input
              value={enrollExpireHours}
              onChange={({ detail }) => setEnrollExpireHours(detail.value)}
              placeholder="e.g. 72"
            />
          </FormField>
          <FormField label="Note (optional)" description="Shown only in the API response.">
            <Input value={enrollNote} onChange={({ detail }) => setEnrollNote(detail.value)} />
          </FormField>
        </ColumnLayout>
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="primary" onClick={() => void handleGenerate()} loading={enrollLoading}>
            Generate code
          </Button>
          {enrollResult ? (
            <Button onClick={() => void copyEnrollmentToken()}>{enrollCopied ? "Copied" : "Copy code"}</Button>
          ) : null}
        </SpaceBetween>
        {enrollError ? (
          <Alert type="error" dismissible onDismiss={() => setEnrollError(null)}>
            {enrollError}
          </Alert>
        ) : null}
        {enrollResult ? (
          <SpaceBetween size="s">
            <Alert type="success" header="Pairing code (6 digits)">
              <Box variant="code" fontSize="display-l" margin={{ top: "xs" }} fontWeight="bold">
                {formatEnrollmentOtp6(enrollResult.token)}
              </Box>
              <Box fontSize="body-s" margin={{ top: "s" }} color="text-body-secondary">
                Uses remaining after creation: {enrollResult.uses}
                {enrollResult.expires_at
                  ? ` · Expires: ${new Date(enrollResult.expires_at).toLocaleString()}`
                  : ""}
              </Box>
            </Alert>
          </SpaceBetween>
        ) : null}

        <Container
          header={
            <Header
              variant="h3"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  {enrollTokens.some((t) => (t.uses_remaining ?? 0) > 0) ? (
                    <Button
                      onClick={() => {
                        if (!confirm("Revoke all pairing codes? Any unused codes will become unusable.")) return;
                        setEnrollTokensError(null);
                        void onRevokeAllTokens()
                          .then(() => loadEnrollmentTokens())
                          .catch((e: unknown) =>
                            setEnrollTokensError(String((e as { message?: string })?.message ?? e)),
                          );
                      }}
                      disabled={enrollTokensLoading}
                    >
                      Revoke all
                    </Button>
                  ) : null}
                  <Button onClick={() => void loadEnrollmentTokens()} loading={enrollTokensLoading}>
                    Refresh
                  </Button>
                </SpaceBetween>
              }
            >
              Keys
            </Header>
          }
        >
          <SpaceBetween size="s">
            {enrollTokensError ? (
              <Alert type="error" dismissible onDismiss={() => setEnrollTokensError(null)}>
                {enrollTokensError}
              </Alert>
            ) : null}
            <Table
              items={enrollTokens}
              columnDefinitions={tokenColumns}
              variant="embedded"
              loading={enrollTokensLoading}
              loadingText={`Loading keys\u2026`}
              empty={<Box color="text-body-secondary">No enrollment keys yet.</Box>}
            />
            {Object.entries(tokenUses)
              .filter(([, v]) => v.rows.length > 0 || v.loading || v.error)
              .map(([tokenId, v]) => (
                <Container key={tokenId} header={<Header variant="h3">Uses for {tokenId}</Header>}>
                  {v.error ? (
                    <Alert type="error" dismissible onDismiss={() => setTokenUses((p) => ({ ...p, [tokenId]: { ...v, error: null } }))}>
                      {v.error}
                    </Alert>
                  ) : null}
                  {v.loading ? (
                    <Box color="text-body-secondary" fontSize="body-s">
                      {`Loading\u2026`}
                    </Box>
                  ) : (
                    <Table
                      items={v.rows}
                      columnDefinitions={[
                        {
                          id: "used_at",
                          header: "Used at",
                          cell: (r: { used_at: string; agent_name: string; agent_id: string | null }) => new Date(r.used_at).toLocaleString(),
                        },
                        {
                          id: "agent_name",
                          header: "Agent name",
                          cell: (r: { used_at: string; agent_name: string; agent_id: string | null }) => r.agent_name,
                        },
                        {
                          id: "agent_id",
                          header: "Agent id",
                          cell: (r: { used_at: string; agent_name: string; agent_id: string | null }) => r.agent_id ?? "\u2014",
                        },
                      ]}
                      variant="embedded"
                      empty={<Box color="text-body-secondary">No uses recorded yet.</Box>}
                    />
                  )}
                </Container>
              ))}
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ExpandableSection>
  );
}
