import { Form, FormField, Input, Button, SpaceBetween, Alert, Box } from "../components/ui/console";
import { useEffect, useState } from "react";
import { AuthLayout } from "../layouts/AuthLayout";
import { api, apiUrl, isApiError } from "../lib/api";

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [oidcEnabled, setOidcEnabled] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  useEffect(() => {
    api
      .authConfig()
      .then((data) => {
        if (typeof data.oidc_enabled === "boolean") setOidcEnabled(data.oidc_enabled);
      })
      .catch(() => { /* ignore */ });
  }, []);

  const handleSubmit = async () => {
    if (!username.trim()) {
      setError("Username is required");
      return;
    }
    if (!password.trim()) {
      setError("Password is required");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await api.login(username, password, totpRequired ? totpCode.trim() : undefined);
        onLoginSuccess();
    } catch (err) {
      if (isApiError(err)) {
        const payload = (err.payload ?? {}) as {
          error?: string;
          attempts_remaining?: number;
          max_attempts_per_window?: number;
          retry_after_secs?: number;
          totp_required?: boolean;
        };
        const base = payload.error ?? err.message ?? "Login failed";
        if (payload.totp_required) {
          const attempted = totpRequired && totpCode.trim().length > 0;
          setTotpRequired(true);
          // Reveal the code field silently the first time; only show an error
          // once the user has actually submitted a (wrong) code.
          setError(attempted ? base : null);
        } else if (err.status === 429 && typeof payload.retry_after_secs === "number") {
          setError(`${base} Retry in about ${Math.ceil(payload.retry_after_secs)}s.`);
        } else if (err.status === 401 && typeof payload.attempts_remaining === "number") {
          const n = payload.attempts_remaining;
          const max = payload.max_attempts_per_window;
          const suffix = ` ${n} attempt${n === 1 ? "" : "s"} remaining before lockout${
            typeof max === "number" ? ` (limit: ${max} wrong passwords / 15 min)` : ""
          }.`;
          setError(base + suffix);
        } else {
          setError(base);
        }
      } else {
        setError("Failed to connect to server. Please try again.");
      }
      console.error("Login error:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <Box className="vantyr-auth-form-wrap">
        <Form
          actions={
            <SpaceBetween direction="horizontal" size="xs" className="vantyr-auth-actions">
              {oidcEnabled && (
                <Button
                  variant="normal"
                  onClick={() => {
                    window.location.href = apiUrl("/auth/oidc/login");
                  }}
                  disabled={loading}
                >
                  Sign in with Authentik
                </Button>
              )}
              <Button
                className="vantyr-auth-submit"
                variant="primary"
                onClick={handleSubmit}
                loading={loading}
                disabled={!username.trim() || !password.trim() || (totpRequired && !totpCode.trim())}
              >
                Sign in
              </Button>
            </SpaceBetween>
          }
        >
          <SpaceBetween size="l">
            <Box className="vantyr-auth-error-slot">
              {error && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>
                  {error}
                </Alert>
              )}
            </Box>

            {oidcEnabled && <Box padding={{ vertical: "s" }} />}

            <FormField
              label="Username"
            >
              <Input
                value={username}
                onChange={(e) => setUsername(e.detail.value)}
                placeholder="Enter username"
                disabled={loading}
                autoFocus
                onKeyDown={(e) => {
                  if (e.detail.key === "Enter") {
                    handleSubmit();
                  }
                }}
              />
            </FormField>

            <FormField
              label="Password"
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.detail.value)}
                placeholder="Enter password"
                disabled={loading}
                onKeyDown={(e) => {
                  if (e.detail.key === "Enter") {
                    handleSubmit();
                  }
                }}
              />
            </FormField>

            {totpRequired && (
              <FormField
                label="Authenticator code"
                description="Enter the 6-digit code from your authenticator app, or a recovery code."
              >
                <Input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.detail.value)}
                  placeholder="123456"
                  disabled={loading}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.detail.key === "Enter") {
                      handleSubmit();
                    }
                  }}
                />
              </FormField>
            )}
          </SpaceBetween>
        </Form>
      </Box>
    </AuthLayout>
  );
}
