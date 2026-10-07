import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageActions } from "@/components/fleet/AppShell";
import { api } from "@/api";
import type { StorageUsage } from "@/api/types";
import { useSession } from "@/app/providers/useSession";
import { AgentEnrollmentSettings } from "@/components/settings/AgentEnrollmentSettings";
import type { PendingAgentClaim } from "@/components/fleet/PendingApprovalsCard";
import { DataRetentionSettings } from "@/components/settings/DataRetentionSettings";
import { RecallCaptureSettings } from "@/components/settings/RecallCaptureSettings";
import { UrlCategorizationSettings } from "@/components/settings/UrlCategorizationSettings";
import { SecuritySettings } from "@/components/settings/SecuritySettings";
import { NotificationsSettings } from "@/components/settings/NotificationsSettings";
import { BrowserPushToggle } from "@/components/settings/BrowserPushToggle";
import { SystemAboutSettings } from "@/components/settings/SystemAboutSettings";

type EnrollmentToken = Awaited<ReturnType<typeof api.listAgentEnrollmentTokens>>["tokens"][number];

export function SettingsPage() {
  const { navUser: currentUser } = useSession();
  const [retention, setRetention] = useState({ keylog_days: 0, window_days: 0, url_days: 0 });
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [githubRelease, setGithubRelease] = useState<{
    tag: string | null;
    releasesUrl: string;
  } | null>(null);
  const [githubReleaseLoading, setGithubReleaseLoading] = useState(false);
  const [githubReleaseError, setGithubReleaseError] = useState<string | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agentAutoUpdateEnabled, setAgentAutoUpdateEnabled] = useState<boolean | null>(null);
  const [agentAutoUpdateLoadErr, setAgentAutoUpdateLoadErr] = useState<string | null>(null);

  const [urlCatStatus, setUrlCatStatus] = useState<{
    settings: {
      enabled: boolean;
      auto_update: boolean;
      source_url: string;
      last_update_at: string | null;
      last_update_error: string | null;
    };
    active_release: { sha256: string | null };
    counts: { categories: number; domains: number; urls: number };
    job?: {
      state: "idle" | "downloading" | "importing" | "ready" | "error";
      started_at: string | null;
      updated_at: string;
      bytes_total: number | null;
      bytes_done: number;
      message: string | null;
    } | null;
  } | null>(null);
  const [urlCatLoading, setUrlCatLoading] = useState(false);
  const [urlCatError, setUrlCatError] = useState<string | null>(null);
  const [urlCatSaving, setUrlCatSaving] = useState(false);


  const [enrollClaims, setEnrollClaims] = useState<PendingAgentClaim[]>([]);
  const [enrollClaimsLoading, setEnrollClaimsLoading] = useState(false);
  const [enrollClaimsLoadedAt, setEnrollClaimsLoadedAt] = useState<Date | null>(null);

  const [enrollTokens, setEnrollTokens] = useState<EnrollmentToken[]>([]);
  const [enrollTokensLoading, setEnrollTokensLoading] = useState(false);
  const [enrollTokensError, setEnrollTokensError] = useState<string | null>(null);

  const isAdmin = currentUser?.role === "admin";

  const loadEnrollmentTokens = useCallback(async () => {
    if (!isAdmin) return;
    setEnrollTokensLoading(true);
    setEnrollTokensError(null);
    try {
      const r = await api.listAgentEnrollmentTokens();
      setEnrollTokens(r.tokens ?? []);
    } catch (e: unknown) {
      setEnrollTokensError(String((e as { message?: string })?.message ?? e));
      setEnrollTokens([]);
    } finally {
      setEnrollTokensLoading(false);
    }
  }, [isAdmin]);

  const loadEnrollmentClaims = useCallback(async () => {
    if (!isAdmin) return;
    setEnrollClaimsLoading(true);
    try {
      const r = await api.listAgentEnrollmentClaims();
      setEnrollClaims(r.claims ?? []);
      setEnrollClaimsLoadedAt(new Date());
    } catch {
      setEnrollClaims([]);
    } finally {
      setEnrollClaimsLoading(false);
    }
  }, [isAdmin]);

  const loadGithubRelease = useCallback(async (nocache: boolean) => {
    setGithubReleaseLoading(true);
    setGithubReleaseError(null);
    try {
      const v = await api.settingsVersionGet({ nocache });
      setGithubRelease({
        tag: v.latest_server_release,
        releasesUrl: v.releases_url,
      });
    } catch (e: unknown) {
      setGithubReleaseError(String((e as { message?: string })?.message || "Failed to load GitHub release"));
      if (!nocache) setGithubRelease(null);
    } finally {
      setGithubReleaseLoading(false);
    }
  }, []);

  const loadMeta = useCallback(async () => {
    setLoadingMeta(true);
    try {
      const [r, s] = await Promise.all([api.retentionGlobalGet(), api.storageUsage()]);
      setRetention({
        keylog_days: r.keylog_days ?? 0,
        window_days: r.window_days ?? 0,
        url_days: r.url_days ?? 0,
      });
      setStorage(s);
    } catch {
      /* retention/storage optional */
    }
    try {
      const au = await api.agentAutoUpdateGlobalGet();
      setAgentAutoUpdateEnabled(au.enabled);
      setAgentAutoUpdateLoadErr(null);
    } catch {
      setAgentAutoUpdateEnabled(null);
      setAgentAutoUpdateLoadErr("Could not load the global agent auto-update policy.");
    } finally {
      setLoadingMeta(false);
    }
    if (isAdmin) {
      try {
        const st = await api.urlCategorizationStatusGet();
        setUrlCatStatus(st as typeof urlCatStatus);
        setUrlCatError(null);
      } catch (e) {
        setUrlCatStatus(null);
        setUrlCatError(String(e));
      }
    }
    await loadEnrollmentTokens();
    await loadEnrollmentClaims();
  }, [isAdmin, loadEnrollmentClaims, loadEnrollmentTokens]);

  const refreshUrlCategorization = useCallback(async () => {
    if (!isAdmin) return;
    setUrlCatLoading(true);
    setUrlCatError(null);
    try {
      const st = await api.urlCategorizationStatusGet();
      setUrlCatStatus(st as typeof urlCatStatus);
    } catch (e) {
      setUrlCatError(String(e));
    } finally {
      setUrlCatLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const running = urlCatStatus?.job?.state === "downloading" || urlCatStatus?.job?.state === "importing";
    if (!running) return;
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshUrlCategorization();
    }, 5000);
    return () => window.clearInterval(t);
  }, [isAdmin, refreshUrlCategorization, urlCatStatus?.job?.state]);

  const saveUrlCategorization = async (patch: Partial<{ enabled: boolean; auto_update: boolean; source_url: string }>) => {
    if (!isAdmin) return;
    const cur = urlCatStatus?.settings;
    const next = {
      enabled: patch.enabled ?? cur?.enabled ?? false,
      auto_update: patch.auto_update ?? cur?.auto_update ?? true,
      source_url:
        (patch.source_url ?? cur?.source_url ?? "https://github.com/olbat/ut1-blacklists/archive/refs/heads/master.tar.gz").trim(),
    };
    if (!next.source_url) {
      setUrlCatError("source_url is required");
      return;
    }
    setUrlCatSaving(true);
    setUrlCatError(null);
    try {
      await api.urlCategorizationSettingsPut(next);
      await refreshUrlCategorization();
    } catch (e) {
      setUrlCatError(String(e));
    } finally {
      setUrlCatSaving(false);
    }
  };

  const urlCatUpdateNow = async () => {
    if (!isAdmin) return;
    setUrlCatLoading(true);
    setUrlCatError(null);
    try {
      await api.urlCategorizationUpdateNow();
      await refreshUrlCategorization();
    } catch (e) {
      setUrlCatError(String(e));
    } finally {
      setUrlCatLoading(false);
    }
  };

  const saveGlobalAutoUpdate = async (enabled: boolean) => {
    if (!isAdmin) return;
    const res = await api.agentAutoUpdateGlobalPut({ enabled });
    setAgentAutoUpdateEnabled(res.enabled);
  };

  useEffect(() => {
    void loadMeta();
    void loadGithubRelease(false);
  }, [loadGithubRelease, loadMeta]);

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

  const save = async () => {
    if (!isAdmin) return;
    setSaving(true);
    try {
      await api.retentionGlobalPut({
        keylog_days: retention.keylog_days === 0 ? null : retention.keylog_days,
        window_days: retention.window_days === 0 ? null : retention.window_days,
        url_days: retention.url_days === 0 ? null : retention.url_days,
      });
      await loadMeta();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageActions>
        <Button onClick={() => void save()} disabled={saving || !isAdmin}>
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

        <UrlCategorizationSettings
          isAdmin={isAdmin}
          urlCatStatus={urlCatStatus}
          urlCatSaving={urlCatSaving}
          urlCatLoading={urlCatLoading}
          urlCatError={urlCatError}
          setUrlCatStatus={setUrlCatStatus}
          saveUrlCategorization={saveUrlCategorization}
          urlCatUpdateNow={urlCatUpdateNow}
          refreshUrlCategorization={refreshUrlCategorization}
          loadOverrides={(q) => api.urlCategorizationOverridesList({ q, limit: 500, offset: 0 }).then((r) => r.rows ?? [])}
          loadUrlCategories={() => api.urlCategorizationCategoriesGet().then((r) => r.categories ?? [])}
          onAddOverride={async (body) => { await api.urlCategorizationOverridesUpsert(body); }}
          onDeleteOverride={async (kind, id) => { await api.urlCategorizationOverridesDelete(kind, id); }}
          onRecalcUrlVisits={async () => { await api.urlCategorizationRecalcUrlVisits({ limit: 100_000 }); }}
          onRecalcUrlSessions={async () => { await api.urlCategorizationRecalcUrlSessions({ limit: 100_000 }); }}
        />

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
          onRefreshMeta={loadMeta}
          onSaveAutoUpdate={saveGlobalAutoUpdate}
        />
      </div>
    </div>
  );
}
