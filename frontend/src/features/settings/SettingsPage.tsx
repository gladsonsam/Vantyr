import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageActions } from "@/app/shell/AppShell";
import { api } from "@/api";
import { enrollmentKeys, enrollmentQueries } from "@/api/queries/enrollment";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import { urlCategoryKeys } from "@/api/queries/urlCategories";
import { useServerDraft } from "@/hooks/useServerDraft";
import { useSession } from "@/app/providers/useSession";
import { AgentEnrollmentSettings } from "@/features/enrollment/AgentEnrollmentSettings";
import type { PendingAgentClaim } from "@/features/enrollment/PendingApprovalsCard";
import { DataRetentionSettings } from "./DataRetentionSettings";
import { RecallCaptureSettings } from "@/features/recall/components/RecallCaptureSettings";
import { UrlCategorizationSettings } from "./UrlCategorizationSettings";
import { useUrlCategorization } from "./hooks/useUrlCategorization";
import { SecuritySettings } from "./SecuritySettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { BrowserPushToggle } from "./BrowserPushToggle";
import { SystemAboutSettings } from "./SystemAboutSettings";

type EnrollmentToken = Awaited<ReturnType<typeof api.listAgentEnrollmentTokens>>["tokens"][number];

const NO_RETENTION = { keylog_days: 0, window_days: 0, url_days: 0 };
const NO_TOKENS: EnrollmentToken[] = [];
const NO_CLAIMS: PendingAgentClaim[] = [];

/** `e.message`, falling back to the value itself (the old loaders' error format). */
function messageOf(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

function toRetentionDraft(r: { keylog_days?: number | null; window_days?: number | null; url_days?: number | null }) {
  return { keylog_days: r.keylog_days ?? 0, window_days: r.window_days ?? 0, url_days: r.url_days ?? 0 };
}

export function SettingsPage() {
  const { navUser: currentUser } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = currentUser?.role === "admin";

  // ── Retention (editable), storage and the global auto-update policy ───────
  const retentionQuery = useQuery(settingsQueries.retention());
  const storageQuery = useQuery(settingsQueries.storage());
  const autoUpdateQuery = useQuery(settingsQueries.autoUpdate());
  const [retention, setRetention] = useServerDraft(retentionQuery.data, retentionQuery.dataUpdatedAt, toRetentionDraft, NO_RETENTION);
  const storage = storageQuery.data ?? null;
  const loadingMeta = retentionQuery.isFetching || storageQuery.isFetching || autoUpdateQuery.isFetching;
  const agentAutoUpdateEnabled = autoUpdateQuery.isError ? null : autoUpdateQuery.data?.enabled ?? null;
  const agentAutoUpdateLoadErr = autoUpdateQuery.isError ? "Could not load the global agent auto-update policy." : null;

  // ── Latest GitHub release ─────────────────────────────────────────────────
  const releaseQuery = useQuery(settingsQueries.releaseCheck());
  const githubRelease = releaseQuery.data
    ? { tag: releaseQuery.data.latest_server_release, releasesUrl: releaseQuery.data.releases_url }
    : null;
  const githubReleaseLoading = releaseQuery.isFetching;
  const githubReleaseError = releaseQuery.error
    ? String((releaseQuery.error as { message?: string })?.message || "Failed to load GitHub release")
    : null;
  // A failed forced re-check keeps the last known release on screen (the query keeps its data).
  const loadGithubRelease = (nocache: boolean) =>
    queryClient.fetchQuery(settingsQueries.releaseCheck(nocache)).then(() => undefined, () => undefined);

  // ── URL categorization (admin) ────────────────────────────────────────────
  const urlCat = useUrlCategorization(isAdmin);

  // ── Enrollment (admin) ────────────────────────────────────────────────────
  const tokensQuery = useQuery({ ...enrollmentQueries.tokens(), enabled: isAdmin });
  const enrollTokens = tokensQuery.isError ? NO_TOKENS : tokensQuery.data?.tokens ?? NO_TOKENS;
  const enrollTokensLoading = tokensQuery.isFetching;
  // `undefined` shows the list's own load error; the token actions report theirs here.
  const [enrollTokensActionError, setEnrollTokensError] = useState<string | null | undefined>(undefined);
  const enrollTokensError =
    enrollTokensActionError !== undefined ? enrollTokensActionError : tokensQuery.error ? messageOf(tokensQuery.error) : null;
  const loadEnrollmentTokens = async () => {
    if (!isAdmin) return;
    setEnrollTokensError(undefined);
    await tokensQuery.refetch();
  };

  const claimsQuery = useQuery({ ...enrollmentQueries.claims(), enabled: isAdmin });
  const enrollClaims: PendingAgentClaim[] = claimsQuery.isError ? NO_CLAIMS : claimsQuery.data?.claims ?? NO_CLAIMS;
  const enrollClaimsLoading = claimsQuery.isFetching;
  const enrollClaimsLoadedAt = claimsQuery.dataUpdatedAt ? new Date(claimsQuery.dataUpdatedAt) : null;
  const loadEnrollmentClaims = async () => {
    if (!isAdmin) return;
    await queryClient.invalidateQueries({ queryKey: enrollmentKeys.claims() });
  };

  const approveEnrollmentClaim = async (claim: PendingAgentClaim, agentName: string) => {
    if (!isAdmin) return;
    await api.approveAgentEnrollmentClaim(claim.id, { agent_name: agentName });
    await loadEnrollmentClaims();
  };

  const rejectEnrollmentClaim = async (claim: PendingAgentClaim) => {
    if (!isAdmin) return;
    await api.rejectAgentEnrollmentClaim(claim.id);
    await loadEnrollmentClaims();
  };

  // ── Reload / save ─────────────────────────────────────────────────────────
  const reloadMeta = async () => {
    urlCat.clearError();
    setEnrollTokensError(undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsKeys.retention() }),
      queryClient.invalidateQueries({ queryKey: settingsKeys.storage() }),
      queryClient.invalidateQueries({ queryKey: settingsKeys.autoUpdate() }),
      queryClient.invalidateQueries({ queryKey: urlCategoryKeys.status() }),
      queryClient.invalidateQueries({ queryKey: enrollmentKeys.tokens() }),
      queryClient.invalidateQueries({ queryKey: enrollmentKeys.claims() }),
    ]);
  };

  const saveGlobalAutoUpdate = async (enabled: boolean) => {
    if (!isAdmin) return;
    const res = await api.agentAutoUpdateGlobalPut({ enabled });
    queryClient.setQueryData(settingsKeys.autoUpdate(), res);
  };

  const saveRetention = useMutation({
    mutationFn: () =>
      api.retentionGlobalPut({
        keylog_days: retention.keylog_days === 0 ? null : retention.keylog_days,
        window_days: retention.window_days === 0 ? null : retention.window_days,
        url_days: retention.url_days === 0 ? null : retention.url_days,
      }),
    onSuccess: () => reloadMeta(),
  });
  const saving = saveRetention.isPending;
  const save = () => {
    if (!isAdmin) return;
    saveRetention.mutate();
  };

  return (
    <div className="flex flex-col gap-8">
      <PageActions>
        <Button onClick={save} disabled={saving || !isAdmin}>
          {saving && <Spinner />} Save settings
        </Button>
      </PageActions>

      <div className="flex flex-col gap-8">
        <AgentEnrollmentSettings
          isAdmin={isAdmin}
          enrollClaims={enrollClaims}
          enrollClaimsLoading={enrollClaimsLoading}
          enrollClaimsLoadedAt={enrollClaimsLoadedAt}
          onRefreshClaims={loadEnrollmentClaims}
          onApproveClaim={approveEnrollmentClaim}
          onRejectClaim={rejectEnrollmentClaim}
          enrollTokens={enrollTokens}
          enrollTokensLoading={enrollTokensLoading}
          enrollTokensError={enrollTokensError}
          setEnrollTokensError={setEnrollTokensError}
          loadEnrollmentTokens={loadEnrollmentTokens}
          onGenerateToken={(body) => api.createAgentEnrollmentToken(body)}
          onRevokeToken={async (id) => { await api.revokeAgentEnrollmentToken(id); }}
          onRevokeAllTokens={async () => { await api.revokeAllAgentEnrollmentTokens(); }}
          onListTokenUses={(id) => api.listAgentEnrollmentTokenUses(id).then((r) => r.uses ?? [])}
        />

        <DataRetentionSettings
          isAdmin={isAdmin}
          retention={retention}
          onChange={(patch) => setRetention((prev) => ({ ...prev, ...patch }))}
        />

        <RecallCaptureSettings isAdmin={isAdmin} />

        <UrlCategorizationSettings isAdmin={isAdmin} urlCat={urlCat} />

        <SecuritySettings />

        <BrowserPushToggle />

        <NotificationsSettings isAdmin={isAdmin} />

        <SystemAboutSettings
          isAdmin={isAdmin}
          loadingMeta={loadingMeta}
          storage={storage}
          githubRelease={githubRelease}
          githubReleaseLoading={githubReleaseLoading}
          githubReleaseError={githubReleaseError}
          agentAutoUpdateEnabled={agentAutoUpdateEnabled}
          agentAutoUpdateLoadErr={agentAutoUpdateLoadErr}
          onCheckGithubRelease={loadGithubRelease}
          onRefreshMeta={reloadMeta}
          onSaveAutoUpdate={saveGlobalAutoUpdate}
        />
      </div>
    </div>
  );
}
