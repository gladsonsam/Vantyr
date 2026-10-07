import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

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
            <Field>
              <FieldLabel htmlFor="twofa-disable-code">Disable two-factor auth</FieldLabel>
              <Input
                id="twofa-disable-code"
                value={disableCode}
                placeholder="123456"
                disabled={busy}
                autoComplete="one-time-code"
                inputMode="numeric"
                onChange={(event) => setDisableCode(event.target.value)}
                className="h-9"
              />
              <p className="text-sm text-muted-foreground">
                Enter a current authenticator code (or a recovery code) to turn it off.
              </p>
            </Field>
            <div>
              <Button disabled={busy || !disableCode.trim()} onClick={disable}>
                {busy && <Spinner />} Disable 2FA
              </Button>
            </div>
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
            <Field>
              <FieldLabel htmlFor="twofa-enroll-code">2. Enter the 6-digit code to confirm</FieldLabel>
              <Input
                id="twofa-enroll-code"
                value={enrollCode}
                placeholder="123456"
                disabled={busy}
                autoComplete="one-time-code"
                inputMode="numeric"
                onChange={(event) => setEnrollCode(event.target.value)}
                className="h-9"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={busy || enrollCode.trim().length < 6}
                onClick={enable}
              >
                {busy && <Spinner />} Enable 2FA
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
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
