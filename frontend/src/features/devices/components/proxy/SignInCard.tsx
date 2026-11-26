import { useState } from "react";
import { UserX } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { useNetworkAccess } from "@/features/network/access/useNetworkAccess";
import { useNetworkAdmin } from "@/features/network/access/useNetworkAdmin";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { IssueCredentialDialog } from "@/features/network/proxy/IssueCredentialDialog";
import {
  credentialsForDevice,
  credentialStatus,
  PROXY_CREDENTIAL_HELP,
  STATUS_TEXT,
} from "@/features/network/proxy/proxyAccessLib";
import {
  useProxyAccessQuery,
  useRevokeCredentialMutation,
} from "@/features/network/runtime/useRuntimeQueries";
import { cn } from "@/lib/utils";
import { useDevice } from "../../deviceContext";
import { OverviewCard } from "../OverviewCard";

const TITLE = "Sign-in";

function CredentialRows({
  isAdmin,
  credentials,
}: {
  isAdmin: boolean;
  credentials: ReturnType<typeof credentialsForDevice>;
}) {
  const revoke = useRevokeCredentialMutation();
  const [now] = useState(() => Date.now());
  return (
    <ul className="divide-y divide-border/60">
      {credentials.map((credential) => {
        const status = credentialStatus(credential, now);
        const text = STATUS_TEXT[status];
        return (
          <li
            key={credential.id}
            className="flex flex-wrap items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div className="space-y-0.5">
              <span className={cn("flex items-center gap-1.5 text-sm font-medium", text.className)}>
                <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                {text.label}
              </span>
              <div className="text-sm">
                {credential.label}
                {credential.personLabel ? (
                  <span className="text-muted-foreground"> · {credential.personLabel}</span>
                ) : null}
              </div>
              <div className="text-[0.8125rem] text-muted-foreground">
                Expires <TimeAgo iso={credential.expiresAt} />
                {" · "}
                {credential.lastUsedAt ? (
                  <>
                    Last used <TimeAgo iso={credential.lastUsedAt} />
                  </>
                ) : (
                  "Never used"
                )}
              </div>
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
  );
}

/**
 * How the proxy can tell who signs in on this device: the credentials issued for it and who is
 * signed in now. A sign-in is evidence only, never proof of who is using the device.
 */
export function SignInCard({ label }: { label: string }) {
  const access = useNetworkAccess();
  const household = access.state === "ready" ? access.household.id : null;
  // The admin check needs a household, so it only runs once one is known.
  return household ? (
    <SignInWithAdmin household={household} label={label} />
  ) : (
    <SignInBody household={null} isAdmin={false} label={label} />
  );
}

function SignInWithAdmin({ household, label }: { household: string; label: string }) {
  const isAdmin = useNetworkAdmin(household);
  return <SignInBody household={household} isAdmin={isAdmin} label={label} />;
}

function SignInBody({
  household,
  isAdmin,
  label,
}: {
  household: string | null;
  isAdmin: boolean;
  label: string;
}) {
  const device = useDevice();
  const query = useProxyAccessQuery();
  if (query.isPending) return null;
  if (query.isError) return <UnavailableSection title={TITLE} reason="Couldn’t load proxy sign-in." />;
  if (query.data.state === "unavailable") {
    return (
      <UnavailableSection title={TITLE} reason="Proxy sign-in isn’t available on this server yet." />
    );
  }
  const view = query.data.data;
  const mine = credentialsForDevice(view.credentials, device.deviceId ?? null, label);
  const ids = new Set(mine.map((c) => c.id));
  const sessions = view.sessions.filter(
    (s) => !s.revoked && (s.deviceId === device.deviceId || ids.has(s.credentialId)),
  );
  return (
    <OverviewCard
      title={TITLE}
      help={
        <HelpTip label="What is this?">
          {PROXY_CREDENTIAL_HELP} Revoking a credential also ends its sessions.
        </HelpTip>
      }
    >
      <div className="space-y-4">
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credential is issued for this device.</p>
        ) : (
          <CredentialRows isAdmin={isAdmin} credentials={mine} />
        )}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Signed in now</h4>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one is signed in via the proxy.</p>
          ) : (
            <ul className="space-y-1.5">
              {sessions.map((s) => (
                <li key={s.id} className="text-sm">
                  Signed in via the proxy as {s.personLabel}
                  <span className="text-muted-foreground">
                    {" "}
                    · last active <TimeAgo iso={s.lastActiveAt} />. Evidence only, not proof of who
                    is using the device.
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {isAdmin && household && device.deviceId && view.enrollment.available ? (
          <IssueCredentialDialog
            household={household}
            fixedDeviceId={device.deviceId}
            triggerLabel="Issue credential for this device"
            variant="outline"
          />
        ) : null}
      </div>
    </OverviewCard>
  );
}
