import { useQuery } from "@tanstack/react-query";
import { networkQueries } from "@/api/queries/network";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { PageLoading } from "@/features/network/components/PageLoading";
import { QueryError } from "@/features/network/components/QueryError";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { BindingsSection } from "./BindingsSection";
import { EnrollmentGrantsSection } from "./EnrollmentGrantsSection";
import { EnrollmentLinkSection } from "./EnrollmentLinkSection";

/** Admin-only: who may enroll their own devices, as which person, and which devices are authorized. */
export function NetworkAccessPage() {
  const household = useNetworkHousehold();
  // The grants list is served to network administrators only, so it doubles as the admin check.
  const grants = useQuery({ ...networkQueries.grants(household.id), retry: false });
  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Access"
        description="Let people enroll their own devices, mapped to a person in your household."
      />
      {grants.isPending ? (
        <PageLoading />
      ) : grants.isError ? (
        <QueryError
          title="Access"
          error={grants.error}
          scope="network_admin"
          onRetry={() => void grants.refetch()}
        />
      ) : (
        <>
          <EnrollmentLinkSection household={household.id} />
          <EnrollmentGrantsSection household={household.id} />
          <BindingsSection household={household.id} />
        </>
      )}
    </div>
  );
}
