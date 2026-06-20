import { useEffect, useState } from "react";
import { Alert, Box, Button, Container, FormField, Header, Input, SpaceBetween } from "../ui/console";
import { api } from "../../lib/api";

const MONO = "'IBM Plex Mono', Consolas, monospace";

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Alert type="success">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Save your recovery codes</div>
      <Box fontSize="body-s" color="text-body-secondary">
        Each can be used once if you lose access to your authenticator. They will not be shown again.
      </Box>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          marginTop: 8,
          fontFamily: MONO,
          fontSize: 13,
          userSelect: "all",
        }}
      >
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
    </Alert>
  );
}

export function TwoFactorSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .twofaStatus()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startSetup = () => {
    setErr(null);
    setBusy(true);
    setRecoveryCodes(null);
    api
      .twofaSetup()
      .then((s) => setSetup(s))
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const enable = () => {
    setErr(null);
    setBusy(true);
    api
      .twofaEnable(enrollCode.trim())
      .then((r) => {
        setEnabled(true);
        setSetup(null);
        setEnrollCode("");
        setRecoveryCodes(r.recovery_codes);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const disable = () => {
    setErr(null);
    setBusy(true);
    api
      .twofaDisable(disableCode.trim())
      .then(() => {
        setEnabled(false);
        setDisableCode("");
        setRecoveryCodes(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Protect your own dashboard sign-in with a time-based code from an authenticator app (Google Authenticator, Authy, 1Password, …). Optional and per-account."
        >
          Two-factor authentication
        </Header>
      }
    >
      <SpaceBetween size="m">
        {err ? (
          <Alert type="error" dismissible onDismiss={() => setErr(null)}>
            {err}
          </Alert>
        ) : null}

        {loading ? (
          <Box color="text-body-secondary">{`Loading…`}</Box>
        ) : enabled ? (
          <SpaceBetween size="m">
            <Box fontSize="body-s" color="text-body-secondary">
              Status: <strong>Enabled</strong>
            </Box>
            {recoveryCodes ? <RecoveryCodes codes={recoveryCodes} /> : null}
            <FormField
              label="Disable two-factor auth"
              description="Enter a current authenticator code (or a recovery code) to turn it off."
            >
              <Input
                value={disableCode}
                placeholder="123456"
                disabled={busy}
                onChange={({ detail }) => setDisableCode(detail.value)}
              />
            </FormField>
            <Button loading={busy} disabled={busy || !disableCode.trim()} onClick={disable}>
              Disable 2FA
            </Button>
          </SpaceBetween>
        ) : setup ? (
          <SpaceBetween size="m">
            <Box fontSize="body-s" color="text-body-secondary">
              1. Add this secret key to your authenticator app (or open the link on a device that has the app):
            </Box>
            <Box>
              <span style={{ fontFamily: MONO, fontSize: 15, userSelect: "all", wordBreak: "break-all" }}>
                {setup.secret}
              </span>
            </Box>
            <Box fontSize="body-s">
              <a href={setup.otpauth_uri} style={{ color: "var(--gr, #20dd8f)", wordBreak: "break-all" }}>
                {setup.otpauth_uri}
              </a>
            </Box>
            <FormField label="2. Enter the 6-digit code to confirm">
              <Input
                value={enrollCode}
                placeholder="123456"
                disabled={busy}
                onChange={({ detail }) => setEnrollCode(detail.value)}
              />
            </FormField>
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || enrollCode.trim().length < 6}
                onClick={enable}
              >
                Enable 2FA
              </Button>
              <Button variant="link" disabled={busy} onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        ) : (
          <SpaceBetween size="m">
            <Box fontSize="body-s" color="text-body-secondary">
              Status: <strong>Not enabled</strong>
            </Box>
            {recoveryCodes ? <RecoveryCodes codes={recoveryCodes} /> : null}
            <Button variant="primary" loading={busy} disabled={busy} onClick={startSetup}>
              Set up 2FA
            </Button>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}
