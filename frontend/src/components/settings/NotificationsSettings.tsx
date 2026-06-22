import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Box, Button, Container, Header, SpaceBetween, Spinner } from "../ui/console";
import { api } from "../../lib/api";
import type { NotificationProviderInfo, NotificationTestResult } from "../../lib/types";

interface NotificationsSettingsProps {
  isAdmin: boolean;
}

function EnvKey({ name }: { name: string }) {
  return (
    <code
      style={{
        fontFamily: "var(--mono)",
        fontSize: "11px",
        background: "var(--card-2, var(--surface-3))",
        border: "1px solid var(--line, transparent)",
        borderRadius: 5,
        padding: "1px 6px",
        color: "var(--text-2)",
        whiteSpace: "nowrap",
      }}
    >
      {name}
    </code>
  );
}

function ProviderRow({ p }: { p: NotificationProviderInfo }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 0",
        borderTop: "1px solid var(--line, rgba(255,255,255,0.06))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Box fontWeight="bold">{p.label}</Box>
        <Badge color={p.enabled ? "green" : "grey"}>{p.enabled ? "Configured" : "Not configured"}</Badge>
        {p.docs_url ? (
          <a
            href={p.docs_url}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12, color: "var(--gr, var(--active))" }}
          >
            Setup guide ↗
          </a>
        ) : null}
      </div>
      <Box fontSize="body-s" color="text-body-secondary">
        {p.description}
      </Box>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <Box fontSize="body-s" color="text-body-secondary">
          Env:
        </Box>
        {p.env_keys.map((k) => (
          <EnvKey key={k} name={k} />
        ))}
      </div>
    </div>
  );
}

export function NotificationsSettings({ isAdmin }: NotificationsSettingsProps) {
  const [providers, setProviders] = useState<NotificationProviderInfo[] | null>(null);
  const [anyEnabled, setAnyEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<NotificationTestResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await api.notificationsStatus();
      setProviders(r.providers);
      setAnyEnabled(r.any_enabled);
    } catch (e: unknown) {
      setLoadError(String((e as { message?: string })?.message ?? e));
      setProviders(null);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    setTestResults(null);
    try {
      const r = await api.notificationsTest();
      setTestResults(r.results);
    } catch (e: unknown) {
      setTestError(String((e as { message?: string })?.message ?? e));
    } finally {
      setTesting(false);
    }
  }, []);

  const labelById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of providers ?? []) m[p.id] = p.label;
    return m;
  }, [providers]);

  const configuredCount = (providers ?? []).filter((p) => p.enabled).length;

  return (
    <Container
      header={
        <Header
          variant="h2"
          counter={providers ? `(${configuredCount}/${providers.length})` : undefined}
          description="Fired alert rules (URL, keystroke, resource threshold, agent offline) are delivered to every channel configured below. Configure each channel with environment variables on the server, then restart. Secrets stay on the server."
          actions={
            <Button iconName="refresh" onClick={() => void load()} loading={loading} disabled={!isAdmin}>
              Refresh
            </Button>
          }
        >
          Alert notification channels
        </Header>
      }
    >
      <SpaceBetween size="m">
        {!isAdmin ? (
          <Box color="text-body-secondary">Administrator role required to view notification channels.</Box>
        ) : loadError ? (
          <Alert type="error" header="Couldn't load notification channels">
            {loadError}
          </Alert>
        ) : providers === null && loading ? (
          <Box color="text-body-secondary">
            <Spinner size="normal" /> Loading channels…
          </Box>
        ) : providers ? (
          <>
            {!anyEnabled ? (
              <Alert type="info" header="No channels configured yet">
                Set the environment variables for any channel below (for example <code>SLACK_WEBHOOK_URL</code> or the
                <code> SMTP_*</code> variables) on the server and restart. See <code>.env.example</code>.
              </Alert>
            ) : null}

            <div>
              {providers.map((p) => (
                <ProviderRow key={p.id} p={p} />
              ))}
            </div>

            <SpaceBetween size="xs">
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Button
                  variant="primary"
                  onClick={() => void runTest()}
                  loading={testing}
                  disabled={!anyEnabled || testing}
                >
                  Send test notification
                </Button>
                {!anyEnabled ? (
                  <Box fontSize="body-s" color="text-body-secondary">
                    Configure a channel first.
                  </Box>
                ) : (
                  <Box fontSize="body-s" color="text-body-secondary">
                    Delivers a sample alert to every configured channel.
                  </Box>
                )}
              </SpaceBetween>

              {testError ? (
                <Alert type="error" dismissible onDismiss={() => setTestError(null)} header="Test failed">
                  {testError}
                </Alert>
              ) : null}

              {testResults ? (
                <SpaceBetween size="xs">
                  {testResults.map((r) => (
                    <Alert
                      key={r.id}
                      type={r.ok ? "success" : "error"}
                      header={`${labelById[r.id] ?? r.id}: ${r.ok ? "delivered" : "failed"}`}
                    >
                      {r.ok ? "Test notification sent successfully." : r.error ?? "Unknown error."}
                    </Alert>
                  ))}
                </SpaceBetween>
              ) : null}
            </SpaceBetween>
          </>
        ) : null}
      </SpaceBetween>
    </Container>
  );
}
