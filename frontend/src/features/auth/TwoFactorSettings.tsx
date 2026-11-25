import { useCallback, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { api, errorText } from "@/api";
import { authQueries } from "@/api/queries/auth";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { HelpTip } from "@/components/common/HelpTip";
import { disableCodeSchema, enrollCodeSchema, type TwoFactorCodeValues } from "./twoFactorSchemas";
import { TwoFactorCodeForm } from "./TwoFactorCodeForm";

interface SetupSecret {
  secret: string;
  otpauth_uri: string;
}

/** Which action failed, so its message lands next to the control the person just used. */
interface ActionError {
  source: "setup" | "enable" | "disable";
  message: string;
}

/** Moves keyboard focus to an element the moment it appears (stable callback, runs once on mount). */
function useFocusOnMount() {
  return useCallback((element: HTMLElement | null) => element?.focus(), []);
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function RetryAlert({ message, fetching, onRetry }: { message: string; fetching: boolean; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        <Button variant="outline" size="sm" className="pointer-coarse:h-9" disabled={fetching} onClick={onRetry}>
          {fetching && <Spinner />} Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function StartSetup({ busy, error, onStart }: { busy: boolean; error: string | null; onStart: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      {error ? <ErrorNotice message={error} /> : null}
      <Button className="pointer-coarse:h-10" disabled={busy} onClick={onStart}>
        {busy && <Spinner />} {busy ? "Starting setup…" : "Set up 2FA"}
      </Button>
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const focusOnMount = useFocusOnMount();
  return (
    <section
      ref={focusOnMount}
      tabIndex={-1}
      aria-labelledby="twofa-recovery-title"
      className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div>
        <h3 id="twofa-recovery-title" className="text-sm font-medium">Save your recovery codes</h3>
        <p className="text-sm text-muted-foreground">
          Each works once if you lose your authenticator. They will not be shown again.
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 font-mono text-[13px] select-all min-[400px]:grid-cols-2">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <CopyTextButton text={codes.join("\n")} label="Copy codes" />
        <Button variant="ghost" size="sm" className="pointer-coarse:h-9" onClick={onDone}>
          I’ve saved them
        </Button>
      </div>
    </section>
  );
}

function SetupSteps({ setup, busy, error, onEnable, onCancel }: {
  setup: SetupSecret;
  busy: boolean;
  error: string | null;
  onEnable: (values: TwoFactorCodeValues) => void;
  onCancel: () => void;
}) {
  const focusOnMount = useFocusOnMount();
  return (
    <ol className="flex list-decimal flex-col gap-5 pl-5 marker:text-muted-foreground">
      <li className="pl-1">
        <div className="flex flex-col gap-3">
          <p ref={focusOnMount} tabIndex={-1} className="text-sm font-medium outline-none">
            Add this key to your authenticator app
          </p>
          <p className="rounded-lg bg-muted/50 p-3 font-mono text-[15px] break-all select-all">{setup.secret}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <CopyTextButton text={setup.secret} label="Copy key" />
            <a href={setup.otpauth_uri} className="text-sm text-primary underline-offset-4 hover:underline">
              Open in authenticator app
            </a>
          </div>
        </div>
      </li>
      <li className="pl-1">
        <div className="flex flex-col gap-4">
          <TwoFactorCodeForm
            schema={enrollCodeSchema}
            id="twofa-enroll-code"
            label="Enter the 6-digit code to confirm"
            submitLabel="Enable 2FA"
            busy={busy}
            error={error}
            onSubmit={onEnable}
            extraAction={(
              <Button variant="ghost" className="pointer-coarse:h-10" disabled={busy} onClick={onCancel}>
                Cancel setup
              </Button>
            )}
          />
        </div>
      </li>
    </ol>
  );
}

function StatusLine({ enabled, statusRef }: { enabled: boolean; statusRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={statusRef} tabIndex={-1} className="flex items-start gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {enabled ? (
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">{enabled ? "Enabled" : "Not enabled"}</p>
        <p className="text-sm text-muted-foreground">
          {enabled ? "Signing in asks for a code from your authenticator app." : "Signing in uses only your password."}
        </p>
      </div>
    </div>
  );
}

/** The setup, enable and disable actions with their state; `statusRef` is where focus goes when a form disappears. */
function useTwoFactorFlow(statusRef: RefObject<HTMLDivElement | null>) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [setup, setSetup] = useState<SetupSecret | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const setEnabled = (next: boolean) =>
    queryClient.setQueryData(authQueries.twofaStatus().queryKey, (s) => ({ pending: false, ...s, enabled: next }));
  const fail = (source: ActionError["source"]) => (e: unknown) => setActionError({ source, message: errorText(e) });

  const setupMutation = useMutation({
    mutationFn: () => api.twofaSetup(),
    onSuccess: (s) => {
      setSetup(s);
      return queryClient.invalidateQueries({ queryKey: authQueries.twofaStatus().queryKey });
    },
    onError: fail("setup"),
  });

  const enableMutation = useMutation({
    mutationFn: (code: string) => api.twofaEnable(code),
    onSuccess: (r) => {
      setEnabled(true);
      setSetup(null);
      setRecoveryCodes(r.recovery_codes);
    },
    onError: fail("enable"),
  });

  const disableMutation = useMutation({
    mutationFn: (code: string) => api.twofaDisable(code),
    onSuccess: () => {
      setEnabled(false);
      setRecoveryCodes(null);
      // The code box is gone; keep keyboard users on the new status.
      statusRef.current?.focus();
    },
    onError: fail("disable"),
  });

  const busy = setupMutation.isPending || enableMutation.isPending || disableMutation.isPending;
  const setupError = actionError?.source === "setup" ? actionError.message : null;
  const errorFor = (source: ActionError["source"]) => (actionError?.source === source ? actionError.message : null);

  const startSetup = () => {
    setActionError(null);
    setRecoveryCodes(null);
    setupMutation.mutate();
  };
  const enable = ({ code }: TwoFactorCodeValues) => {
    setActionError(null);
    enableMutation.mutate(code);
  };
  const disable = ({ code }: TwoFactorCodeValues) => {
    setActionError(null);
    disableMutation.mutate(code);
  };
  const cancelSetup = () => {
    setActionError(null);
    setSetup(null);
    statusRef.current?.focus();
  };
  const dismissRecoveryCodes = () => {
    setRecoveryCodes(null);
    statusRef.current?.focus();
  };

  return { setup, recoveryCodes, busy, setupError, errorFor, startSetup, enable, disable, cancelSetup, dismissRecoveryCodes };
}

type TwoFactorFlow = ReturnType<typeof useTwoFactorFlow>;

/** Whichever action fits the known status: turn off, finish setup, or start setup. */
function TwoFactorActions({ enabled, flow }: { enabled: boolean; flow: TwoFactorFlow }) {
  if (enabled) {
    return (
      <TwoFactorCodeForm
        schema={disableCodeSchema}
        id="twofa-disable-code"
        label="Code to turn off two-factor authentication"
        hint="Enter a current authenticator code, or a recovery code."
        submitLabel="Disable 2FA"
        submitVariant="destructive"
        codeKind="text"
        busy={flow.busy}
        error={flow.errorFor("disable")}
        onSubmit={flow.disable}
      />
    );
  }
  if (flow.setup) {
    return <SetupSteps setup={flow.setup} busy={flow.busy} error={flow.errorFor("enable")} onEnable={flow.enable} onCancel={flow.cancelSetup} />;
  }
  return <StartSetup busy={flow.busy} error={flow.setupError} onStart={flow.startSetup} />;
}

function TwoFactorContent() {
  const statusQuery = useQuery(authQueries.twofaStatus());
  const statusRef = useRef<HTMLDivElement>(null);
  const flow = useTwoFactorFlow(statusRef);
  const retry = () => void statusQuery.refetch();

  if (statusQuery.isPending) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </p>
    );
  }
  const status = statusQuery.data;
  if (!status) {
    // Without a known status "Not enabled" could be false, and offering setup could replace a working one.
    return <RetryAlert message={`Couldn’t load your two-factor status: ${errorText(statusQuery.error)}`} fetching={statusQuery.isFetching} onRetry={retry} />;
  }
  return (
    <>
      {statusQuery.isRefetchError ? (
        <RetryAlert message="Couldn’t refresh your two-factor status, so this may be out of date." fetching={statusQuery.isFetching} onRetry={retry} />
      ) : null}
      <StatusLine enabled={status.enabled} statusRef={statusRef} />
      {flow.recoveryCodes ? <RecoveryCodes codes={flow.recoveryCodes} onDone={flow.dismissRecoveryCodes} /> : null}
      <TwoFactorActions enabled={status.enabled} flow={flow} />
    </>
  );
}

export function TwoFactorSettings() {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-1.5">
          Two-factor authentication
          <HelpTip>Protect your own dashboard sign-in with a time-based code from an authenticator app (Google Authenticator, Authy, 1Password, …). Optional and per-account.</HelpTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        <TwoFactorContent />
      </CardContent>
    </Card>
  );
}
