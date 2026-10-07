import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@vantyr/ui/components/field";
import { Input } from "@vantyr/ui/components/input";
import { Spinner } from "@vantyr/ui/components/spinner";
import { AuthLayout } from "./AuthLayout";
import { api, apiUrl, isApiError } from "@/api";
import { authQueries } from "@/api/queries/auth";
import { canAutoRedirectToSso, redirectToSso } from "./sso";

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ssoRedirecting, setSsoRedirecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  // A failed config load just leaves the SSO button hidden.
  const authConfig = useQuery(authQueries.config()).data;
  const oidcEnabled = authConfig?.oidc_enabled === true;

  useEffect(() => {
    // Opt-in server flag (OIDC_AUTO_LOGIN=1): skip this screen entirely and
    // hop straight to the IdP. A live IdP session bounces straight back
    // with a fresh cookie — no click needed after a session expiry.
    if (authConfig?.oidc_enabled && authConfig.oidc_auto_login && canAutoRedirectToSso()) {
      setSsoRedirecting(true);
      redirectToSso();
    }
  }, [authConfig]);

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

  if (ssoRedirecting) {
    return (
      <AuthLayout>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">Redirecting to single sign-on…</p>
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = apiUrl("/auth/oidc/login");
            }}
          >
            Continue to SSO
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="flex flex-col gap-5">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Field>
            <FieldLabel htmlFor="login-username">Username</FieldLabel>
            <Input
              id="login-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter username"
              disabled={loading}
              autoFocus
              autoComplete="username"
              className="h-9"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="login-password">Password</FieldLabel>
            <Input
              id="login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
              disabled={loading}
              autoComplete="current-password"
              className="h-9"
            />
          </Field>

          {totpRequired && (
            <Field>
              <FieldLabel htmlFor="login-totp">Authenticator code</FieldLabel>
              <Input
                id="login-totp"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
                placeholder="123456"
                disabled={loading}
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                className="h-9"
              />
              <FieldDescription>
                Enter the 6-digit code from your authenticator app, or a recovery code.
              </FieldDescription>
            </Field>
          )}

          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              size="lg"
              disabled={loading || !username.trim() || !password.trim() || (totpRequired && !totpCode.trim())}
            >
              {loading && <Spinner />} Sign in
            </Button>
            {oidcEnabled && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={() => {
                  window.location.href = apiUrl("/auth/oidc/login");
                }}
                disabled={loading}
              >
                Sign in with Authentik
              </Button>
            )}
          </div>
        </div>
      </form>
    </AuthLayout>
  );
}
