import { KeyRound } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { errorText } from "@/api";
import { networkQueries, useGrantMutations } from "@/api/queries/network";
import { userQueries } from "@/api/queries/users";
import type { NetworkGrantName } from "@/api/types";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { PageLoading } from "@/features/network/components/PageLoading";
import { QueryError } from "@/features/network/components/QueryError";
import { SettingsSection } from "@/features/settings/components/SettingsLayout";

const GRANT_LABEL: Record<NetworkGrantName, string> = {
  network_admin: "Administrator",
  network_events: "Events",
  network_enroll: "Enrollment",
};

/** Who holds which Network grant, with grant and revoke for the enrollment grant. */
export function EnrollmentGrantsSection({ household }: { household: string }) {
  const grants = useQuery(networkQueries.grants(household));
  const users = useQuery({ ...userQueries.list(), retry: false });
  const { grant, revoke } = useGrantMutations(household);

  if (grants.isPending) return <PageLoading />;
  if (grants.isError)
    return (
      <QueryError
        title="Network grants"
        error={grants.error}
        scope="network_admin"
        onRetry={() => void grants.refetch()}
      />
    );

  const held = new Map<string, Set<NetworkGrantName>>();
  for (const u of users.data?.users ?? []) held.set(u.id, new Set());
  for (const g of grants.data.grants) {
    const set = held.get(g.user_id) ?? new Set<NetworkGrantName>();
    set.add(g.grant_name);
    held.set(g.user_id, set);
  }
  const name = (id: string) => {
    const u = users.data?.users.find((x) => x.id === id);
    return u ? u.display_name || u.username : id;
  };
  const error = grant.error ?? revoke.error;

  return (
    <SettingsSection
      title="Network grants"
      icon={<KeyRound />}
      description="Network access is separate from dashboard roles."
      help={
        <>
          Administrator manages everything in this household. Events lets someone read network
          events. Enrollment only lets a person enroll their own devices and issue setup grants for
          them: it gives no access to events, inventory or policy.
        </>
      }
    >
      {[...held.entries()].map(([userId, set]) => {
        const enrolled = set.has("network_enroll");
        const busy =
          (grant.isPending && grant.variables?.user_id === userId) ||
          (revoke.isPending && revoke.variables?.userId === userId);
        return (
          <div key={userId} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{name(userId)}</div>
              <div className="text-[0.8125rem] text-muted-foreground">
                {set.size === 0
                  ? "No network grants"
                  : [...set].map((g) => GRANT_LABEL[g]).join(" · ")}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                enrolled
                  ? revoke.mutate({ userId, grant: "network_enroll" })
                  : grant.mutate({ user_id: userId, grant: "network_enroll" })
              }
            >
              {busy ? <Spinner /> : null}
              {enrolled ? "Revoke enrollment" : "Grant enrollment"}
            </Button>
          </div>
        );
      })}
      {error ? (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}
    </SettingsSection>
  );
}
