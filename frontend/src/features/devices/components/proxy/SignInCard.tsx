import { UserX } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import HoldButton from "@/components/react-bits/HoldButton";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import {
  useProxyQuery,
  useRevokeCredentialMutation,
} from "@/features/network/runtime/useRuntimeQueries";
import { cn } from "@/lib/utils";
import { OverviewCard } from "../OverviewCard";

const TITLE = "Sign-in";

/** How the proxy tells who is using this device: the credentials issued to it. Revoking takes a hold. */
export function SignInCard({ label }: { label: string }) {
  const query = useProxyQuery();
  const revoke = useRevokeCredentialMutation();
  if (query.isPending) return null;
  if (query.isError) return <UnavailableSection title={TITLE} reason="Couldn’t load the proxy." />;
  if (query.data.state === "unavailable") {
    return <UnavailableSection title={TITLE} reason={query.data.reason} />;
  }
  const credentials = query.data.data.credentials;
  if (credentials.state === "unavailable") {
    return <UnavailableSection title={TITLE} reason={credentials.reason} />;
  }
  const mine = credentials.data.filter((c) => c.label === label);
  return (
    <OverviewCard
      title={TITLE}
      help={
        <HelpTip label="About sign-in">
          A credential is how the proxy recognises this device, or a person who signs in with it.
          Without one, requests from this device are not tied to anyone.
        </HelpTip>
      }
    >
      {mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">No credential is issued to this device.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {mine.map((credential) => (
            <li
              key={credential.id}
              className="flex flex-wrap items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
            >
              <div className="space-y-0.5">
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-sm font-medium",
                    credential.revoked ? "text-muted-foreground" : "text-success",
                  )}
                >
                  <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                  {credential.revoked ? "Revoked" : "Active"}
                </span>
                <div className="text-sm text-muted-foreground">
                  {credential.lastUsedAt ? (
                    <>
                      Last used <TimeAgo iso={credential.lastUsedAt} />
                    </>
                  ) : (
                    "Never used"
                  )}
                </div>
              </div>
              {credential.revoked ? null : (
                <HoldButton
                  size="sm"
                  icon={<UserX className="size-4" />}
                  holdTime={900}
                  doneLabel="Revoked"
                  backgroundColor="var(--muted)"
                  textColor="var(--foreground)"
                  fillColor="var(--destructive)"
                  fillTextColor="var(--foreground)"
                  disabled={revoke.isPending}
                  onHold={() => revoke.mutate(credential.id)}
                >
                  Hold to revoke
                </HoldButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </OverviewCard>
  );
}
