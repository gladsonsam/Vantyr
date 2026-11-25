import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@vantyr/ui/components/field";
import { Input } from "@vantyr/ui/components/input";
import { Separator } from "@vantyr/ui/components/separator";
import { Spinner } from "@vantyr/ui/components/spinner";
import { AuthLayout } from "./AuthLayout";
import { api, apiUrl } from "@/api";
import { authQueries } from "@/api/queries/auth";
import { loginFailure } from "./loginErrors";
import { canAutoRedirectToSso, redirectToSso } from "./sso";

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);

  // A failed config load just leaves the SSO button hidden.
  const authConfig = useQuery(authQueries.config()).data;
  const oidcEnabled = authConfig?.oidc_enabled === true;

  // Opt-in server flag (OIDC_AUTO_LOGIN=1): skip this screen entirely and hop
  // straight to the IdP. A live IdP session bounces straight back with a fresh
  // cookie — no click needed after a session expiry. Derived during render so
  // the redirect notice shows on the same commit the config arrives.
  const ssoRedirecting =
    authConfig?.oidc_enabled === true && authConfig.oidc_auto_login === true && canAutoRedirectToSso();

  useEffect(() => {
    if (ssoRedirecting) redirectToSso();
  }, [ssoRedirecting]);

  const goToSso = () => {
    window.location.href = apiUrl("/auth/oidc/login");
  };

  const handleSubmit = async () => {
    if (loading) return;
    if (!username.trim()) {
      setError("Username is required");
      usernameRef.current?.focus();
      return;
    }
    if (!password.trim()) {
      setError("Password is required");
      passwordRef.current?.focus();
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await api.login(username, password, totpRequired ? totpCode.trim() : undefined);
      onLoginSuccess();
    } catch (err) {
      const failure = loginFailure(err, totpRequired && totpCode.trim().length > 0);
      if (failure.totpRequired) setTotpRequired(true);
      setError(failure.message);
      // Point focus at what to fix: a refused code is selected for retyping, anything else goes back to
      // the password.
      const target = failure.totpRequired ? totpRef.current : passwordRef.current;
      target?.focus();
      target?.select();
      console.error("Login error:", err);
    } finally {
      setLoading(false);
    }
  };

  if (ssoRedirecting) {
    return (
      <AuthLayout>
        <div className="flex flex-col gap-4">
          <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Redirecting to single sign-on…
          </p>
          <Button variant="outline" size="lg" onClick={goToSso}>
            Continue to SSO
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle={totpRequired ? "Two-step verification" : undefined}>
      <form
        aria-busy={loading}
        noValidate
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
              ref={usernameRef}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              readOnly={loading}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-9 pointer-coarse:h-10"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="login-password">Password</FieldLabel>
            <Input
              id="login-password"
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              readOnly={loading}
              autoComplete="current-password"
              className="h-9 pointer-coarse:h-10"
            />
          </Field>

          {totpRequired && (
            <Field>
              <FieldLabel htmlFor="login-totp">Authenticator code</FieldLabel>
              <Input
                id="login-totp"
                ref={totpRef}
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
                placeholder="123456"
                readOnly={loading}
                autoFocus
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-9 pointer-coarse:h-10"
              />
              <FieldDescription>
                Enter the 6-digit code from your authenticator app, or a recovery code.
              </FieldDescription>
            </Field>
          )}

          <div className="flex flex-col gap-3">
            <Button
              type="submit"
              size="lg"
              disabled={loading || !username.trim() || !password.trim() || (totpRequired && !totpCode.trim())}
            >
              {loading && <Spinner />} {loading ? "Signing in…" : "Sign in"}
            </Button>
            {oidcEnabled && (
              <>
                <div role="presentation" className="flex items-center gap-3 text-xs text-muted-foreground">
                  <Separator className="flex-1" />
                  or
                  <Separator className="flex-1" />
                </div>
                <Button type="button" variant="outline" size="lg" onClick={goToSso} disabled={loading}>
                  Sign in with Authentik
                </Button>
              </>
            )}
          </div>
        </div>
      </form>
    </AuthLayout>
  );
}
