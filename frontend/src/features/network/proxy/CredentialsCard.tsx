import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, UserX } from "lucide-react";
import { networkQueries } from "@/api/queries/network";
import { HelpTip } from "@/components/common/HelpTip";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import type { ProxyAccessView } from "@/features/network/runtime/types";
import {
  useRevokeAllForPersonMutation,
  useRevokeCredentialMutation,
} from "@/features/network/runtime/useRuntimeQueries";
import { cn } from "@/lib/utils";
import { IssueCredentialDialog } from "./IssueCredentialDialog";
import { credentialStatus, PROXY_CREDENTIAL_HELP, STATUS_TEXT } from "./proxyAccessLib";

/**
 * Proxy sign-in credentials: how the proxy tells which person signed in. Not a gateway worker token,
 * not a setup grant, not HTTPS-inspection trust. Revoking is hard to undo, so it takes a deliberate hold.
 */
export function SignInCredentialsCard({
  household,
  access,
  isAdmin,
}: {
  household: string;
  access: ProxyAccessView;
  isAdmin: boolean;
}) {
  const revoke = useRevokeCredentialMutation();
  const revokeAll = useRevokeAllForPersonMutation();
  const persons = useQuery({ ...networkQueries.persons(household), enabled: isAdmin });
  const devices = useQuery(networkQueries.devices(household));
  const deviceLabel = new Map((devices.data?.devices ?? []).map((d) => [d.id, d.label]));
  const [now] = useState(() => Date.now());

  const credentials = [...access.credentials].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activePeople = [
    ...new Set(
      credentials
        .filter((c) => credentialStatus(c, now) === "active" && c.personLabel)
        .map((c) => c.personLabel as string),
    ),
  ];
  const personIdByName = new Map((persons.data?.persons ?? []).map((p) => [p.display_name, p.id]));

  return (
    <SettingsSection
      title="Sign-in credentials"
      icon={<KeyRound />}
      description="Let a person sign in through the proxy. Signing in is evidence of who is using a device, not proof."
      help={PROXY_CREDENTIAL_HELP}
      action={
        isAdmin && access.enrollment.available ? (
          <IssueCredentialDialog household={household} />
        ) : null
      }
    >
      {!access.enrollment.available ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {access.enrollment.reason ?? "Issuing credentials is not available right now."}
        </p>
      ) : null}
      {credentials.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No credentials have been issued.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {credentials.map((credential) => {
            const status = credentialStatus(credential, now);
            const text = STATUS_TEXT[status];
            return (
              <li
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium">{credential.label}</span>
                    <span
                      className={cn("flex items-center gap-1.5 text-sm font-medium", text.className)}
                    >
                      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                      {text.label}
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {credential.personLabel ?? "No person"}
                    {" · "}
                    {credential.deviceId
                      ? (deviceLabel.get(credential.deviceId) ?? "One device")
                      : "Any device"}
                  </div>
                  <div className="text-[0.8125rem] text-muted-foreground">
                    Created <TimeAgo iso={credential.createdAt} />
                    {" · "}
                    {credential.revokedAt ? (
                      <>
                        Revoked <TimeAgo iso={credential.revokedAt} />
                      </>
                    ) : (
                      <>
                        Expires <TimeAgo iso={credential.expiresAt} />
                      </>
                    )}
                    {" · "}
                    {credential.lastUsedAt ? (
                      <>
                        Last used <TimeAgo iso={credential.lastUsedAt} />
                      </>
                    ) : (
                      "Never used"
                    )}
                  </div>
                  {credential.scopes.length > 0 ? (
                    <div className="text-xs text-muted-foreground">
                      Scopes: {credential.scopes.join(", ")}
                    </div>
                  ) : null}
                </div>
                {isAdmin && status === "active" ? (
                  <HoldAction
                    icon={<UserX className="size-4" />}
                    ariaLabel={`Hold to revoke ${credential.label}`}
                    doneLabel="Revoked"
                    disabled={revoke.isPending}
                    onHold={() => revoke.mutate(credential.id)}
                  >
                    Hold to revoke
                  </HoldAction>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {isAdmin && activePeople.length > 0 ? (
        <div className="space-y-3 border-t border-border/50 px-5 py-4">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            Revoke everything for a person
            <HelpTip label="About revoking a credential">
              Revoking a credential also ends its live sessions. Revoking all for a person does this
              for every credential they hold, and cannot be undone.
            </HelpTip>
          </h4>
          <ul className="space-y-2">
            {activePeople.map((name) => {
              const id = personIdByName.get(name);
              return (
                <li key={name} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm">{name}</span>
                  {id ? (
                    <HoldAction
                      icon={<UserX className="size-4" />}
                      ariaLabel={`Hold to revoke all credentials for ${name}`}
                      doneLabel="Revoked"
                      disabled={revokeAll.isPending}
                      onHold={() => revokeAll.mutate(id)}
                    >
                      Revoke all for {name}
                    </HoldAction>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </SettingsSection>
  );
}
