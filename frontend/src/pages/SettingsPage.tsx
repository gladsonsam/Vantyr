import { ContentLayout, SpaceBetween, Header, Button } from "../components/ui/console";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ThemeMode } from "../hooks/useTheme";
import type { DashboardNavUser, StorageUsage } from "../lib/types";
import { AppearanceSettings } from "../components/settings/AppearanceSettings";
import { TwoFactorSettings } from "../components/settings/TwoFactorSettings";
import { AgentEnrollmentSettings } from "../components/settings/AgentEnrollmentSettings";
import type { PendingAgentClaim } from "../components/overview/PendingAgentApprovals";
import { DataRetentionSettings } from "../components/settings/DataRetentionSettings";
import { UrlCategorizationSettings } from "../components/settings/UrlCategorizationSettings";
import { SecuritySettings } from "../components/settings/SecuritySettings";
import { SystemAboutSettings } from "../components/settings/SystemAboutSettings";

interface SettingsPageProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onBack?: () => void;
  currentUser?: DashboardNavUser | null;
}

type EnrollmentToken = Awaited<ReturnType<typeof api.listAgentEnrollmentTokens>>["tokens"][number];

export function SettingsPage({
  themeMode,
  onThemeChange,
  onBack,
  currentUser = null,
}: SettingsPageProps) {
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

  const [localUiPasswordSet, setLocalUiPasswordSet] = useState<boolean | null>(null);

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
      const ui = await api.localUiPasswordGlobalGet();
      setLocalUiPasswordSet(ui.password_set);
    } catch {
      setLocalUiPasswordSet(null);
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

  const saveGlobalLocalUiPassword = async (password: string | null) => {
    if (!isAdmin) return;
    const r = await api.localUiPasswordGlobalPut({ password });
    setLocalUiPasswordSet(r.password_set);
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
    await api.approveAgentEnrollmentClaim(claim.id, { agent_name: agentName });
    await loadEnrollmentClaims();
  };

  const rejectEnrollmentClaim = async (claim: PendingAgentClaim) => {
    await api.rejectAgentEnrollmentClaim(claim.id);
    await loadEnrollmentClaims();
  };

  const save = async () => {
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
    <ContentLayout>
      <div className="vantyr-admin-page vantyr-settings-page sx-console">
        <SpaceBetween size="l">
          <Header
            variant="h1"
            description="Configure server connection, telemetry retention, and storage. Open Activity log from the top bar for the central audit trail."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {onBack && (
                  <Button iconName="angle-left" onClick={onBack}>
                    Back
                  </Button>
                )}
                <Button variant="primary" onClick={save} loading={saving}>
                  Save settings
                </Button>
              </SpaceBetween>
            }
          >
            Settings
          </Header>

          <AppearanceSettings themeMode={themeMode} onThemeChange={onThemeChange} />

          <TwoFactorSettings />

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
            retention={retention}
            onChange={(patch) => setRetention((prev) => ({ ...prev, ...patch }))}
          />

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

          <SecuritySettings
            isAdmin={isAdmin}
            loadingMeta={loadingMeta}
            localUiPasswordSet={localUiPasswordSet}
            onSavePassword={saveGlobalLocalUiPassword}
          />

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
        </SpaceBetween>
      </div>
    </ContentLayout>
  );
}
