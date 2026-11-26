import { useState, type ReactNode } from "react";
import { Ban, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { errorText } from "@/api";
import { networkQueries, useGatewayCredentialMutations } from "@/api/queries/network";
import type { NetworkGateway, NetworkGatewayCredential } from "@/api/types";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import { QueryError } from "@/features/network/components/QueryError";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { CredentialRequestFields } from "./CredentialRequestFields";
import {
  DEFAULT_CREDENTIAL_REQUEST,
  toCredentialBody,
  valuesFromCommands,
  type CredentialRequestValues,
} from "./credentialRequest";
import { HoldAction } from "./HoldAction";
import type { IssuedToken } from "./IssuedTokenDialog";

function credentialState(credential: NetworkGatewayCredential): {
  label: string;
  text: string;
} {
  if (credential.revoked_at) return { label: "Revoked", text: "text-destructive" };
  if (new Date(credential.expires_at).getTime() < Date.now())
    return { label: "Expired", text: "text-warning" };
  return { label: "Active", text: "text-success" };
}

function RequestDialog({
  kind,
  title,
  description,
  triggerContent,
  triggerDisabled,
  submitLabel,
  initial,
  busy,
  error,
  onSubmit,
}: {
  kind: NetworkGateway["kind"];
  title: string;
  description: string;
  triggerContent: ReactNode;
  triggerDisabled?: boolean;
  submitLabel: string;
  initial: CredentialRequestValues;
  busy: boolean;
  error: string | null;
  onSubmit: (values: ReturnType<typeof toCredentialBody>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(initial);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValues(initial);
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" disabled={triggerDisabled} />}>
        {triggerContent}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <CredentialRequestFields
          values={values}
          onChange={setValues}
          idPrefix={`cred-${submitLabel.toLowerCase().replace(/\W+/g, "-")}`}
          kind={kind}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() =>
              void onSubmit(toCredentialBody(values, kind)).then((ok) => {
                if (ok) setOpen(false);
              })
            }
          >
            {busy ? <Spinner /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Worker credentials for one gateway. These are not a person’s proxy sign-in credential. */
export function GatewayCredentialsSection({
  household,
  gateway,
  isAdmin,
  onIssued,
}: {
  household: string;
  gateway: NetworkGateway;
  isAdmin: boolean;
  onIssued: (issued: IssuedToken) => void;
}) {
  const query = useQuery(networkQueries.gatewayCredentials(household, gateway.id));
  const { issue, rotate, revoke } = useGatewayCredentialMutations(household, gateway.id);
  const [error, setError] = useState<string | null>(null);
  const canChange = isAdmin && !gateway.revoked_at;

  const hand = (
    token: { token: string; expires_at: string },
    commands: string[],
  ) =>
    onIssued({
      token: token.token,
      expiresAt: token.expires_at,
      commands,
      gatewayLabel: gateway.label,
      gatewayKind: gateway.kind,
    });

  const issueNew = async (body: ReturnType<typeof toCredentialBody>) => {
    setError(null);
    try {
      hand(await issue.mutateAsync(body), body.commands);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  const rotateOne = async (
    credential: NetworkGatewayCredential,
    body: ReturnType<typeof toCredentialBody>,
  ) => {
    setError(null);
    try {
      hand(await rotate.mutateAsync({ credential: credential.id, ...body }), body.commands);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  const revokeOne = async (id: string) => {
    setError(null);
    try {
      await revoke.mutateAsync(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <SettingsSection
      title="Worker tokens"
      icon={<KeyRound />}
      help="Credentials the gateway worker uses to call Vantyr. They are not a person’s proxy sign-in credential and not a dashboard session. Rotating issues a replacement; pick its commands and expiry again (the old commands are pre-checked). Tokens are never upgraded automatically."
      action={
        canChange ? (
          <RequestDialog
            kind={gateway.kind}
            title="Issue worker token"
            description="The token is shown once. Existing tokens keep working until they expire or are revoked. Request each command the worker needs."
            triggerContent={
              <>
                <Plus /> Issue token
              </>
            }
            submitLabel="Issue token"
            initial={DEFAULT_CREDENTIAL_REQUEST}
            busy={issue.isPending}
            error={error}
            onSubmit={issueNew}
          />
        ) : null
      }
    >
      {query.isPending ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <div className="p-4">
          <QueryError
            title="Worker tokens"
            error={query.error}
            scope="network_admin"
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : query.data.credentials.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No tokens have been issued.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {query.data.credentials.map((credential) => {
            const state = credentialState(credential);
            const live = state.label === "Active";
            return (
              <li
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className={`flex items-center gap-1.5 ${state.text}`}>
                      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                      {state.label}
                    </span>
                    <span className="text-muted-foreground">
                      · {credential.allowed_commands.join(", ")}
                    </span>
                  </div>
                  <div className="text-[0.8125rem] text-muted-foreground">
                    Created <TimeAgo iso={credential.issued_at} /> · expires{" "}
                    <TimeAgo iso={credential.expires_at} /> · last used{" "}
                    {credential.last_used_at ? <TimeAgo iso={credential.last_used_at} /> : "never"}
                    {credential.revoked_at ? (
                      <>
                        {" "}
                        · revoked <TimeAgo iso={credential.revoked_at} />
                      </>
                    ) : null}
                  </div>
                </div>
                {canChange && live ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <RequestDialog
                      kind={gateway.kind}
                      title="Rotate worker token"
                      description="Issues a replacement token, shown once. Choose its commands and expiry; the previous token's commands are pre-checked. The old token keeps working until it expires or is revoked."
                      triggerContent={
                        <>
                          <RefreshCw /> Rotate
                        </>
                      }
                      triggerDisabled={rotate.isPending}
                      submitLabel="Rotate token"
                      initial={valuesFromCommands(credential.allowed_commands)}
                      busy={rotate.isPending}
                      error={error}
                      onSubmit={(body) => rotateOne(credential, body)}
                    />
                    <HoldAction
                      icon={<Ban className="size-4" />}
                      ariaLabel={`Hold to revoke token issued ${credential.issued_at}`}
                      doneLabel="Revoked"
                      disabled={revoke.isPending}
                      onHold={() => void revokeOne(credential.id)}
                    >
                      Hold to revoke
                    </HoldAction>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
