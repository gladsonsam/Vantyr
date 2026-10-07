import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api } from "@/api";
import { authQueries } from "@/api/queries/auth";
import { disableCodeSchema, enrollCodeSchema, type TwoFactorCodeValues } from "./twoFactorSchemas";
import { TwoFactorCodeForm } from "./TwoFactorCodeForm";

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Alert>
      <div className="mb-1 font-semibold">Save your recovery codes</div>
      <AlertDescription>
        Each can be used once if you lose access to your authenticator. They will not be shown again.
      </AlertDescription>
      <div className="mt-2 grid grid-cols-1 gap-1 font-mono text-[13px] select-all sm:grid-cols-2">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
    </Alert>
  );
}

export function TwoFactorSettings() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(authQueries.twofaStatus());
  const loading = statusQuery.isPending;
  const enabled = statusQuery.data?.enabled ?? false;
  // One message slot shared by the status load and the actions; starting an action clears both.
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [statusErrCleared, setStatusErrCleared] = useState(false);
  const err = actionErr ?? (statusQuery.error && !statusErrCleared ? String(statusQuery.error) : null);

  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const setEnabled = (next: boolean) =>
    queryClient.setQueryData(authQueries.twofaStatus().queryKey, (s) => ({ pending: false, ...s, enabled: next }));

  const onActionError = (e: unknown) => setActionErr(String(e));

  const setupMutation = useMutation({
    mutationFn: () => api.twofaSetup(),
    onSuccess: (s) => setSetup(s),
    onError: onActionError,
  });

  const enableMutation = useMutation({
    mutationFn: (code: string) => api.twofaEnable(code),
    onSuccess: (r) => {
      setEnabled(true);
      setSetup(null);
      setRecoveryCodes(r.recovery_codes);
    },
    onError: onActionError,
  });

  const disableMutation = useMutation({
    mutationFn: (code: string) => api.twofaDisable(code),
    onSuccess: () => {
      setEnabled(false);
      setRecoveryCodes(null);
    },
    onError: onActionError,
  });

  const busy = setupMutation.isPending || enableMutation.isPending || disableMutation.isPending;

  const clearErr = () => {
    setActionErr(null);
    setStatusErrCleared(true);
  };

  const startSetup = () => {
    clearErr();
    setRecoveryCodes(null);
    setupMutation.mutate();
  };

  const enable = ({ code }: TwoFactorCodeValues) => {
    clearErr();
    enableMutation.mutate(code);
  };

  const disable = ({ code }: TwoFactorCodeValues) => {
    clearErr();
    disableMutation.mutate(code);
  };

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          Protect your own dashboard sign-in with a time-based code from an authenticator app (Google
          Authenticator, Authy, 1Password, …). Optional and per-account.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        {err ? (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : enabled ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Status: <strong className="text-success">Enabled</strong>
            </p>
            {recoveryCodes ? <RecoveryCodes codes={recoveryCodes} /> : null}
            <TwoFactorCodeForm
              schema={disableCodeSchema}
              id="twofa-disable-code"
              label="Disable two-factor auth"
              hint="Enter a current authenticator code (or a recovery code) to turn it off."
              submitLabel="Disable 2FA"
              busy={busy}
              onSubmit={disable}
            />
          </div>
        ) : setup ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              1. Add this secret key to your authenticator app (or open the link on a device that has the app):
            </p>
            <p className="rounded-lg bg-muted/50 p-3 font-mono text-[15px] break-all select-all">
              {setup.secret}
            </p>
            <p className="text-sm break-all">
              <a href={setup.otpauth_uri} className="text-primary underline-offset-4 hover:underline">
                {setup.otpauth_uri}
              </a>
            </p>
            <TwoFactorCodeForm
              schema={enrollCodeSchema}
              id="twofa-enroll-code"
              label="2. Enter the 6-digit code to confirm"
              submitLabel="Enable 2FA"
              busy={busy}
              onSubmit={enable}
              extraAction={(
                <Button variant="ghost" disabled={busy} onClick={() => setSetup(null)}>
                  Cancel
                </Button>
              )}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Status: <strong>Not enabled</strong>
            </p>
            {recoveryCodes ? <RecoveryCodes codes={recoveryCodes} /> : null}
            <div>
              <Button disabled={busy} onClick={startSetup}>
                {busy && <Spinner />} Set up 2FA
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
