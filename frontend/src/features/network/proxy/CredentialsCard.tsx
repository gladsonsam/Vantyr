import { UserX } from "lucide-react";
import { Card, CardContent } from "@vantyr/ui/components/card";
import HoldButton from "@/components/react-bits/HoldButton";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { useRevokeCredentialMutation } from "@/features/network/runtime/useRuntimeQueries";
import type { ProxyView } from "@/features/network/runtime/types";

type Credentials = Extract<ProxyView["credentials"], { state: "ready" }>["data"];

/**
 * Who can use the proxy. A credential identifies a device, or a person who signs in with it. Revoking is
 * hard to undo, so it takes a deliberate hold rather than a click.
 */
export function CredentialsCard({ credentials }: { credentials: Credentials }) {
  const revoke = useRevokeCredentialMutation();
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-1 p-5">
        <h3 className="font-medium">Credentials</h3>
        <ul className="divide-y divide-border">
          {credentials.map((credential) => (
            <li
              key={credential.id}
              className="flex flex-wrap items-center justify-between gap-4 py-3.5"
            >
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{credential.label}</div>
                <div className="text-sm text-muted-foreground">
                  {credential.revoked ? (
                    "Revoked"
                  ) : credential.lastUsedAt ? (
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
      </CardContent>
    </Card>
  );
}
