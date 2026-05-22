import { useCallback, useEffect, useMemo, useState } from "react";
import ContentLayout from "@cloudscape-design/components/content-layout";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Header from "@cloudscape-design/components/header";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Table from "@cloudscape-design/components/table";
import Box from "@cloudscape-design/components/box";
import Toggle from "@cloudscape-design/components/toggle";
import Alert from "@cloudscape-design/components/alert";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import Modal from "@cloudscape-design/components/modal";
import TextFilter from "@cloudscape-design/components/text-filter";
import { api } from "../lib/api";
import { CategoryManagerModal } from "../components/CategoryManagerModal";
import { PendingAgentApprovals, type PendingAgentClaim } from "../components/overview/PendingAgentApprovals";
import { formatEnrollmentOtp6 } from "../lib/formatEnrollmentCode";
import type { ThemeMode } from "../hooks/useTheme";
import { saveServerSettings, type ServerSettings, getServerSettings } from "../lib/serverSettings";
import type { DashboardNavUser, StorageUsage } from "../lib/types";

interface SettingsPageProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onBack?: () => void;
  currentUser?: DashboardNavUser | null;
}

const THEME_SELECT_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

function formatBytesAdaptive(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "\u2014";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(2)} ${units[idx]}`;
}

export function SettingsPage({
  themeMode,
  onThemeChange,
  onBack,
  currentUser = null,
}: SettingsPageProps) {
  const [settings] = useState<ServerSettings>(getServerSettings);
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
  const [agentAutoUpdateSaveErr, setAgentAutoUpdateSaveErr] = useState<string | null>(null);
  const [agentAutoUpdateSaving, setAgentAutoUpdateSaving] = useState(false);

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
  const [urlOverridesOpen, setUrlOverridesOpen] = useState(false);
  const [urlOverridesLoading, setUrlOverridesLoading] = useState(false);
  const [urlOverridesError, setUrlOverridesError] = useState<string | null>(null);
  const [urlOverridesQuery, setUrlOverridesQuery] = useState("");
  const [urlOverridesRows, setUrlOverridesRows] = useState<
    { id: number; kind: "domain" | "url"; value: string; category_key: string; category_label: string; note: string; created_at: string }[]
  >([]);
  const [urlOverrideAddKind, setUrlOverrideAddKind] = useState<"domain" | "url">("domain");
  const [urlOverrideAddValue, setUrlOverrideAddValue] = useState("");
  const [urlOverrideAddCategory, setUrlOverrideAddCategory] = useState("");
  const [urlOverrideAddNote, setUrlOverrideAddNote] = useState("");
  const [urlOverrideAddSaving, setUrlOverrideAddSaving] = useState(false);
  const [urlCategories, setUrlCategories] = useState<{ key: string; label?: string; enabled: boolean; description: string }[]>([]);

  const [customCatsOpen, setCustomCatsOpen] = useState(false);

  const [localUiPasswordSet, setLocalUiPasswordSet] = useState<boolean | null>(null);
  const [localUiPwd, setLocalUiPwd] = useState("");
  const [localUiPwd2, setLocalUiPwd2] = useState("");
  const [localUiSaveErr, setLocalUiSaveErr] = useState<string | null>(null);
  const [localUiSaveOk, setLocalUiSaveOk] = useState<string | null>(null);
  const [localUiSaving, setLocalUiSaving] = useState(false);

  const [enrollUses, setEnrollUses] = useState(1);
  const [enrollExpireHours, setEnrollExpireHours] = useState("");
  const [enrollNote, setEnrollNote] = useState("");
  const [enrollLoading, setEnrollLoading] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollResult, setEnrollResult] = useState<{
    token: string;
    uses: number;
    expires_at: string | null;
  } | null>(null);

  const [enrollTokens, setEnrollTokens] = useState<
    {
      id: string;
      uses_remaining: number;
      created_at: string;
      expires_at: string | null;
      note: string | null;
      used_count: number;
      last_used_at: string | null;
    }[]
  >([]);
  const [enrollTokensLoading, setEnrollTokensLoading] = useState(false);
  const [enrollTokensError, setEnrollTokensError] = useState<string | null>(null);
  const [tokenUses, setTokenUses] = useState<Record<string, { loading: boolean; error: string | null; rows: { used_at: string; agent_name: string; agent_id: string | null }[] }>>(
    {},
  );
  const [enrollClaims, setEnrollClaims] = useState<PendingAgentClaim[]>([]);
  const [enrollClaimsLoading, setEnrollClaimsLoading] = useState(false);
  const [enrollClaimsError, setEnrollClaimsError] = useState<string | null>(null);
  const [enrollClaimsLoadedAt, setEnrollClaimsLoadedAt] = useState<Date | null>(null);
  const [enrollCopied, setEnrollCopied] = useState(false);

  // (removed) agent credential reset-by-id: prefer deleting agents from the overview.

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
    setEnrollClaimsError(null);
    try {
      const r = await api.listAgentEnrollmentClaims();
      setEnrollClaims(r.claims ?? []);
      setEnrollClaimsLoadedAt(new Date());
    } catch (e: unknown) {
      setEnrollClaimsError(String((e as { message?: string })?.message ?? e));
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
      /* retention/storage optional for About; agent policy loads below */
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
      // Avoid hammering the UI (and server) when the tab isn't visible.
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

  const loadUrlCategories = async () => {
    try {
      const r = await api.urlCategorizationCategoriesGet();
      setUrlCategories(r.categories ?? []);
    } catch {
      setUrlCategories([]);
    }
  };

  const loadOverrides = useCallback(async (q: string) => {
    if (!isAdmin) return;
    setUrlOverridesLoading(true);
    setUrlOverridesError(null);
    try {
      const r = await api.urlCategorizationOverridesList({ q, limit: 500, offset: 0 });
      setUrlOverridesRows(r.rows ?? []);
    } catch (e) {
      setUrlOverridesError(String(e));
      setUrlOverridesRows([]);
    } finally {
      setUrlOverridesLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!urlOverridesOpen || !isAdmin) return;
    void loadUrlCategories();
    void loadOverrides(urlOverridesQuery);
  }, [isAdmin, loadOverrides, urlOverridesOpen, urlOverridesQuery]);

  const saveGlobalLocalUiPassword = async (password: string | null) => {
    if (!isAdmin) return;
    setLocalUiSaving(true);
    setLocalUiSaveErr(null);
    setLocalUiSaveOk(null);
    try {
      const r = await api.localUiPasswordGlobalPut({ password });
      setLocalUiPasswordSet(r.password_set);
      setLocalUiPwd("");
      setLocalUiPwd2("");
      setLocalUiSaveOk(r.password_set ? "Saved. Connected agents will receive the new lock password." : "Removed.");
    } catch (e) {
      setLocalUiSaveErr(String(e));
    } finally {
      setLocalUiSaving(false);
    }
  };

  const saveGlobalAutoUpdate = async (enabled: boolean) => {
    if (!isAdmin) return;
    setAgentAutoUpdateSaving(true);
    setAgentAutoUpdateSaveErr(null);
    try {
      const res = await api.agentAutoUpdateGlobalPut({ enabled });
      setAgentAutoUpdateEnabled(res.enabled);
    } catch (e) {
      setAgentAutoUpdateSaveErr(String(e));
    } finally {
      setAgentAutoUpdateSaving(false);
    }
  };

  useEffect(() => {
    void loadMeta();
    void loadGithubRelease(false);
  }, [loadGithubRelease, loadMeta]);

  const generateEnrollmentToken = async () => {
    if (!isAdmin) return;
    setEnrollLoading(true);
    setEnrollError(null);
    try {
      const uses = Math.max(1, Math.min(100_000, Number(enrollUses) || 1));
      const body: {
        uses: number;
        expires_in_hours?: number;
        note?: string;
      } = { uses };
      const rawH = enrollExpireHours.trim();
      if (rawH !== "") {
        const h = Math.max(1, Math.min(24 * 365, parseInt(rawH, 10) || 0));
        if (h > 0) body.expires_in_hours = h;
      }
      if (enrollNote.trim()) body.note = enrollNote.trim();
      const r = await api.createAgentEnrollmentToken(body);
      setEnrollResult({
        token: r.enrollment_token,
        uses: r.uses,
        expires_at: r.expires_at,
      });
      await loadEnrollmentTokens();
      await loadEnrollmentClaims();
    } catch (e: unknown) {
      setEnrollError(String((e as { message?: string })?.message ?? e));
      setEnrollResult(null);
    } finally {
      setEnrollLoading(false);
    }
  };

  const copyEnrollmentToken = async () => {
    if (!enrollResult?.token) return;
    try {
      await navigator.clipboard.writeText(enrollResult.token);
      setEnrollCopied(true);
      window.setTimeout(() => setEnrollCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const approveEnrollmentClaim = async (claim: PendingAgentClaim, agentName: string) => {
    await api.approveAgentEnrollmentClaim(claim.id, { agent_name: agentName });
    await loadEnrollmentClaims();
  };

  const rejectEnrollmentClaim = async (claim: PendingAgentClaim) => {
    await api.rejectAgentEnrollmentClaim(claim.id);
    await loadEnrollmentClaims();
  };

  const tokenColumns = useMemo(
    () => [
      {
        id: "created_at",
        header: "Created",
        cell: (t: (typeof enrollTokens)[number]) => new Date(t.created_at).toLocaleString(),
      },
      {
        id: "expires_at",
        header: "Expires",
        cell: (t: (typeof enrollTokens)[number]) =>
          t.expires_at ? new Date(t.expires_at).toLocaleString() : "\u2014",
      },
      {
        id: "uses_remaining",
        header: "Uses left",
        cell: (t: (typeof enrollTokens)[number]) => String(t.uses_remaining ?? 0),
      },
      {
        id: "used_count",
        header: "Used",
        cell: (t: (typeof enrollTokens)[number]) => String(t.used_count ?? 0),
      },
      {
        id: "last_used_at",
        header: "Last used",
        cell: (t: (typeof enrollTokens)[number]) =>
          t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "\u2014",
      },
      {
        id: "note",
        header: "Note",
        cell: (t: (typeof enrollTokens)[number]) => (t.note?.trim() ? t.note : "\u2014"),
      },
      {
        id: "actions",
        header: "",
        cell: (t: (typeof enrollTokens)[number]) => (
          <SpaceBetween direction="horizontal" size="xs">
            {(t.used_count ?? 0) > 0 ? (
              <Button
                onClick={() => {
                  const cur = tokenUses[t.id];
                  if (cur?.rows?.length || cur?.loading) return;
                  setTokenUses((prev) => ({ ...prev, [t.id]: { loading: true, error: null, rows: [] } }));
                  void api
                    .listAgentEnrollmentTokenUses(t.id)
                    .then((r) => {
                      setTokenUses((prev) => ({
                        ...prev,
                        [t.id]: { loading: false, error: null, rows: r.uses ?? [] },
                      }));
                    })
                    .catch((e: unknown) => {
                      setTokenUses((prev) => ({
                        ...prev,
                        [t.id]: {
                          loading: false,
                          error: String((e as { message?: string })?.message ?? e),
                          rows: [],
                        },
                      }));
                    });
                }}
              >
                View uses
              </Button>
            ) : null}
            {(t.uses_remaining ?? 0) > 0 ? (
              <Button
                onClick={() => {
                  if (!confirm("Revoke this pairing code? It will become unusable.")) return;
                  void api
                    .revokeAgentEnrollmentToken(t.id)
                    .then(() => loadEnrollmentTokens())
                    .catch((e: unknown) => setEnrollTokensError(String((e as { message?: string })?.message ?? e)));
                }}
              >
                Revoke
              </Button>
            ) : null}
          </SpaceBetween>
        ),
      },
    ],
    [loadEnrollmentTokens, tokenUses],
  );

  const save = async () => {
    setSaving(true);
    try {
      saveServerSettings(settings);
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

        <Container header="Appearance & connection">
          <SpaceBetween size="l">
            <FormField
              label="Theme"
              description="Applied immediately and persisted in browser storage."
            >
              <Select
                selectedOption={
                  THEME_SELECT_OPTIONS.find((o) => o.value === themeMode) ??
                  THEME_SELECT_OPTIONS[0]
                }
                onChange={({ detail }) => {
                  const val = detail.selectedOption.value as ThemeMode | undefined;
                  if (val) onThemeChange(val);
                }}
                options={THEME_SELECT_OPTIONS}
              />
            </FormField>

            {/* (reserved) */}
          </SpaceBetween>
        </Container>

        {isAdmin ? (
          <ExpandableSection
            defaultExpanded={false}
            headerText="Agent enrollment"
            headerDescription="Create pairing codes and approve pending agents."
          >
            <SpaceBetween size="m">
              <Box fontSize="body-s" color="text-body-secondary">
                On the PC, open agent settings (Ctrl+Shift+F12), enter the WebSocket URL and the six digits, then{" "}
                <Box variant="strong" display="inline">
                  Request access
                </Box>
                . Codes create pending agents; approving a claim issues the per-device token.
              </Box>
              <SpaceBetween size="s">
                {enrollClaimsError ? (
                  <Alert type="error" dismissible onDismiss={() => setEnrollClaimsError(null)}>
                    {enrollClaimsError}
                  </Alert>
                ) : null}
                <PendingAgentApprovals
                  claims={enrollClaims}
                  loading={enrollClaimsLoading}
                  lastRefreshedAt={enrollClaimsLoadedAt}
                  onRefresh={loadEnrollmentClaims}
                  onApprove={approveEnrollmentClaim}
                  onReject={rejectEnrollmentClaim}
                />
              </SpaceBetween>
              <ColumnLayout columns={3} variant="text-grid">
                <FormField label="Uses" description="How many claims can use this code.">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={String(enrollUses)}
                    onChange={({ detail }) =>
                      setEnrollUses(Math.max(1, Math.min(100_000, Number(detail.value) || 1)))
                    }
                  />
                </FormField>
                <FormField
                  label="Expires in (hours)"
                  description="Leave empty for 10 minutes."
                >
                  <Input
                    value={enrollExpireHours}
                    onChange={({ detail }) => setEnrollExpireHours(detail.value)}
                    placeholder="e.g. 72"
                  />
                </FormField>
                <FormField label="Note (optional)" description="Shown only in the API response.">
                  <Input value={enrollNote} onChange={({ detail }) => setEnrollNote(detail.value)} />
                </FormField>
              </ColumnLayout>
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="primary" onClick={() => void generateEnrollmentToken()} loading={enrollLoading}>
                  Generate code
                </Button>
                {enrollResult ? (
                  <Button onClick={() => void copyEnrollmentToken()}>{enrollCopied ? "Copied" : "Copy code"}</Button>
                ) : null}
              </SpaceBetween>
              {enrollError ? (
                <Alert type="error" dismissible onDismiss={() => setEnrollError(null)}>
                  {enrollError}
                </Alert>
              ) : null}
              {enrollResult ? (
                <SpaceBetween size="s">
                  <Alert type="success" header="Pairing code (6 digits)">
                    <Box variant="code" fontSize="display-l" margin={{ top: "xs" }} fontWeight="bold">
                      {formatEnrollmentOtp6(enrollResult.token)}
                    </Box>
                    <Box fontSize="body-s" margin={{ top: "s" }} color="text-body-secondary">
                      Uses remaining after creation: {enrollResult.uses}
                      {enrollResult.expires_at
                        ? ` Â· Expires: ${new Date(enrollResult.expires_at).toLocaleString()}`
                        : ""}
                    </Box>
                  </Alert>
                </SpaceBetween>
              ) : null}

              <Container
                header={
                  <Header
                    variant="h3"
                    actions={
                      <SpaceBetween direction="horizontal" size="xs">
                      {enrollTokens.some((t) => (t.uses_remaining ?? 0) > 0) ? (
                        <Button
                          onClick={() => {
                            if (!confirm("Revoke all pairing codes? Any unused codes will become unusable.")) return;
                            setEnrollTokensLoading(true);
                            setEnrollTokensError(null);
                            void api
                              .revokeAllAgentEnrollmentTokens()
                              .then(() => loadEnrollmentTokens())
                              .catch((e: unknown) =>
                                setEnrollTokensError(String((e as { message?: string })?.message ?? e)),
                              )
                              .finally(() => setEnrollTokensLoading(false));
                          }}
                          disabled={enrollTokensLoading}
                        >
                          Revoke all
                        </Button>
                      ) : null}
                        <Button onClick={() => void loadEnrollmentTokens()} loading={enrollTokensLoading}>
                          Refresh
                        </Button>
                      </SpaceBetween>
                    }
                  >
                    Keys
                  </Header>
                }
              >
                <SpaceBetween size="s">
                  {enrollTokensError ? (
                    <Alert type="error" dismissible onDismiss={() => setEnrollTokensError(null)}>
                      {enrollTokensError}
                    </Alert>
                  ) : null}
                  <Table
                    items={enrollTokens}
                    columnDefinitions={tokenColumns}
                    variant="embedded"
                    loading={enrollTokensLoading}
                    loadingText={`Loading keys\u2026`}
                    empty={<Box color="text-body-secondary">No enrollment keys yet.</Box>}
                  />
                  {Object.entries(tokenUses)
                    .filter(([, v]) => v.rows.length > 0 || v.loading || v.error)
                    .map(([tokenId, v]) => (
                      <Container key={tokenId} header={<Header variant="h3">Uses for {tokenId}</Header>}>
                        {v.error ? (
                          <Alert type="error" dismissible onDismiss={() => setTokenUses((p) => ({ ...p, [tokenId]: { ...v, error: null } }))}>
                            {v.error}
                          </Alert>
                        ) : null}
                        {v.loading ? (
                          <Box color="text-body-secondary" fontSize="body-s">
                            {`Loading\u2026`}
                          </Box>
                        ) : (
                          <Table
                            items={v.rows}
                            columnDefinitions={[
                              {
                                id: "used_at",
                                header: "Used at",
                                cell: (r: (typeof v.rows)[number]) => new Date(r.used_at).toLocaleString(),
                              },
                              {
                                id: "agent_name",
                                header: "Agent name",
                                cell: (r: (typeof v.rows)[number]) => r.agent_name,
                              },
                              {
                                id: "agent_id",
                                header: "Agent id",
                                cell: (r: (typeof v.rows)[number]) => r.agent_id ?? "\u2014",
                              },
                            ]}
                            variant="embedded"
                            empty={<Box color="text-body-secondary">No uses recorded yet.</Box>}
                          />
                        )}
                      </Container>
                    ))}
                </SpaceBetween>
              </Container>

              
            </SpaceBetween>
          </ExpandableSection>
        ) : null}

        <Container header="Data retention">
          <SpaceBetween size="s">
            <Box fontSize="body-s" color="text-body-secondary">
              Set to <Box variant="code">0</Box> for unlimited retention (no automatic prune) for that category. Values 1-36500
              delete raw rows older than that many days. Top URL/window aggregates are kept separately.
            </Box>
            <FormField label="Keystrokes retention (days)" description="0 = keep all keystroke sessions.">
              <Input
                type="number"
                inputMode="numeric"
                value={String(retention.keylog_days)}
                onChange={({ detail }) =>
                  setRetention((prev) => ({
                    ...prev,
                    keylog_days: Math.max(0, Math.min(36500, Number(detail.value) || 0)),
                  }))
                }
              />
            </FormField>
            <FormField label="Windows/activity retention (days)" description="0 = keep all window and AFK/active events.">
              <Input
                type="number"
                inputMode="numeric"
                value={String(retention.window_days)}
                onChange={({ detail }) =>
                  setRetention((prev) => ({
                    ...prev,
                    window_days: Math.max(0, Math.min(36500, Number(detail.value) || 0)),
                  }))
                }
              />
            </FormField>
            <FormField label="URLs retention (days)" description="0 = keep all URL visit rows.">
              <Input
                type="number"
                inputMode="numeric"
                value={String(retention.url_days)}
                onChange={({ detail }) =>
                  setRetention((prev) => ({
                    ...prev,
                    url_days: Math.max(0, Math.min(36500, Number(detail.value) || 0)),
                  }))
                }
              />
            </FormField>
          </SpaceBetween>
        </Container>

        <Container header="URL categorization (UT1 Blacklists)">
          {!isAdmin ? (
            <Alert statusIconAriaLabel="Info" type="info">
              Admin only.
            </Alert>
          ) : (
            <SpaceBetween size="m">
              {urlCatError && (
                <Alert statusIconAriaLabel="Error" type="error">
                  {urlCatError}
                </Alert>
              )}
              <ColumnLayout columns={2}>
                <FormField
                  label="Enabled"
                  description="Disabled by default. When enabled, new URL visits are categorized in the background."
                >
                  <Toggle
                    checked={urlCatStatus?.settings.enabled ?? false}
                    onChange={({ detail }) => void saveUrlCategorization({ enabled: detail.checked })}
                    disabled={urlCatSaving}
                  />
                </FormField>
                <FormField
                  label="Auto update"
                  description="When enabled, the server periodically refreshes the list while categorization is enabled."
                >
                  <Toggle
                    checked={urlCatStatus?.settings.auto_update ?? true}
                    onChange={({ detail }) => void saveUrlCategorization({ auto_update: detail.checked })}
                    disabled={urlCatSaving || !(urlCatStatus?.settings.enabled ?? false)}
                  />
                </FormField>
              </ColumnLayout>
              <FormField
                label="Source URL"
                description="Default points to the GitHub mirror tarball over HTTPS. You can switch to a locally hosted or pinned archive URL."
              >
                <Input
                  value={
                    urlCatStatus?.settings.source_url ??
                    "https://github.com/olbat/ut1-blacklists/archive/refs/heads/master.tar.gz"
                  }
                  onChange={({ detail }) =>
                    setUrlCatStatus((prev) =>
                      prev ? { ...prev, settings: { ...prev.settings, source_url: detail.value } } : prev
                    )
                  }
                  disabled={urlCatSaving}
                />
                <Box margin={{ top: "xs" }}>
                  <Button
                    onClick={() => void saveUrlCategorization({ source_url: urlCatStatus?.settings.source_url ?? "" })}
                    loading={urlCatSaving}
                  >
                    Save source URL
                  </Button>
                </Box>
              </FormField>
              <ColumnLayout columns={3} variant="text-grid">
                <Box>
                  <Box variant="awsui-key-label">Last update</Box>
                  <Box>
                    {urlCatStatus?.settings.last_update_at
                      ? new Date(urlCatStatus.settings.last_update_at).toLocaleString()
                      : "\u2014"}
                  </Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Active sha256</Box>
                  <Box variant="code">{urlCatStatus?.active_release.sha256 ?? "\u2014"}</Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Counts</Box>
                  <Box>{`${urlCatStatus?.counts.categories ?? 0} categories  /  ${urlCatStatus?.counts.domains.toLocaleString() ?? 0} domains  /  ${urlCatStatus?.counts.urls.toLocaleString() ?? 0} URLs`}</Box>
                </Box>
              </ColumnLayout>
              {urlCatStatus?.settings.last_update_error && (
                <StatusIndicator type="error">{urlCatStatus.settings.last_update_error}</StatusIndicator>
              )}
              {(urlCatStatus?.job?.state === "downloading" || urlCatStatus?.job?.state === "importing") && (
                <SpaceBetween size="xs">
                  <StatusIndicator type={urlCatStatus.job.state === "downloading" ? "in-progress" : "in-progress"}>
                    {urlCatStatus.job.state === "downloading" ? "Downloading list" : "Importing list"}
                  </StatusIndicator>
                  <ProgressBar
                    value={
                      urlCatStatus.job.bytes_total && urlCatStatus.job.bytes_total > 0
                        ? Math.min(100, Math.floor((urlCatStatus.job.bytes_done / urlCatStatus.job.bytes_total) * 100))
                        : 0
                    }
                    additionalInfo={
                      urlCatStatus.job.bytes_total && urlCatStatus.job.bytes_total > 0
                        ? `${Math.floor(urlCatStatus.job.bytes_done / 1024 / 1024)} / ${Math.floor(urlCatStatus.job.bytes_total / 1024 / 1024)} MB`
                        : `${Math.floor(urlCatStatus.job.bytes_done / 1024 / 1024)} MB`
                    }
                    label={urlCatStatus.job.message ?? ""}
                  />
                </SpaceBetween>
              )}
              <SpaceBetween direction="horizontal" size="xs">
                <Button iconName="refresh" onClick={() => void refreshUrlCategorization()} loading={urlCatLoading}>
                  Refresh
                </Button>
                {urlCatStatus?.settings.enabled ? (
                  <Button onClick={() => setUrlOverridesOpen(true)}>
                    Manage overrides
                  </Button>
                ) : null}
                <Button onClick={() => setCustomCatsOpen(true)}>
                  Custom categories
                </Button>
                {urlCatStatus?.settings.enabled ? (
                  <Button
                    variant="primary"
                    onClick={() => void urlCatUpdateNow()}
                    loading={urlCatLoading}
                  >
                    Download/update now
                  </Button>
                ) : (
                  <Box color="text-body-secondary" padding={{ top: "xs" }} fontSize="body-s">
                    Enable URL categorization to download lists and manage overrides.
                  </Box>
                )}
              </SpaceBetween>
              <Box variant="small">
                Data source: UT1 Blacklists (<Box variant="code">olbat/ut1-blacklists</Box>) licensed under Creative Commons
                BY-SA 4.0.
              </Box>
            </SpaceBetween>
          )}
        </Container>


        <CategoryManagerModal visible={customCatsOpen} onDismiss={() => setCustomCatsOpen(false)} />


        <Modal
          visible={urlOverridesOpen}
          onDismiss={() => setUrlOverridesOpen(false)}
          size="large"
          header="URL category overrides"
          footer={
            <Box float="right">
              <Button variant="link" onClick={() => setUrlOverridesOpen(false)}>
                Close
              </Button>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <Box color="text-body-secondary" fontSize="body-s">
              Overrides apply before UT1 lists and persist across updates. Use domain overrides for hostnames (recommended) and URL overrides for specific prefixes.
            </Box>

            {urlOverridesError && <Alert type="error">{urlOverridesError}</Alert>}

            <ColumnLayout columns={2}>
              <FormField label="Override type">
                <Select
                  selectedOption={{ label: urlOverrideAddKind === "domain" ? "Domain" : "URL prefix", value: urlOverrideAddKind }}
                  options={[
                    { label: "Domain", value: "domain" },
                    { label: "URL prefix", value: "url" },
                  ]}
                  onChange={({ detail }) => setUrlOverrideAddKind(detail.selectedOption.value as "domain" | "url")}
                />
              </FormField>
              <FormField label="Category">
                <Select
                  placeholder="Select category"
                  selectedOption={
                    urlOverrideAddCategory
                      ? { label: urlCategories.find((c) => c.key === urlOverrideAddCategory)?.label ?? urlOverrideAddCategory, value: urlOverrideAddCategory }
                      : null
                  }
                  options={urlCategories
                    .filter((c) => c.enabled)
                    .map((c) => {
                      const key = c.key ?? "";
                      const fallback = key
                        .replace(/[_-]+/g, " ")
                        .split(" ")
                        .filter(Boolean)
                        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(" ");
                      return { label: (c.label ?? "").trim() || fallback || key, value: key };
                    })}
                  onChange={({ detail }) => setUrlOverrideAddCategory(String(detail.selectedOption.value ?? ""))}
                />
              </FormField>
            </ColumnLayout>

            <FormField label={urlOverrideAddKind === "domain" ? "Domain" : "URL prefix"}>
              <Input
                value={urlOverrideAddValue}
                onChange={({ detail }) => setUrlOverrideAddValue(detail.value)}
                placeholder={urlOverrideAddKind === "domain" ? "example.com" : "https://example.com/path"}
              />
            </FormField>
            <FormField label="Note (optional)">
              <Input value={urlOverrideAddNote} onChange={({ detail }) => setUrlOverrideAddNote(detail.value)} />
            </FormField>
            <Button
              variant="primary"
              loading={urlOverrideAddSaving}
              onClick={async () => {
                setUrlOverrideAddSaving(true);
                try {
                  await api.urlCategorizationOverridesUpsert({
                    kind: urlOverrideAddKind,
                    value: urlOverrideAddValue,
                    category_key: urlOverrideAddCategory,
                    note: urlOverrideAddNote,
                  });
                  setUrlOverrideAddValue("");
                  setUrlOverrideAddNote("");
                  await loadOverrides(urlOverridesQuery);
                } catch (e) {
                  setUrlOverridesError(String(e));
                } finally {
                  setUrlOverrideAddSaving(false);
                }
              }}
              disabled={!urlOverrideAddValue.trim() || !urlOverrideAddCategory.trim()}
            >
              Add / update override
            </Button>

            <TextFilter
              filteringText={urlOverridesQuery}
              onChange={({ detail }) => {
                setUrlOverridesQuery(detail.filteringText);
                void loadOverrides(detail.filteringText);
              }}
              filteringPlaceholder="Search overrides (domain/url/category)"
            />

            <SpaceBetween direction="horizontal" size="xs">
              <Button
                onClick={async () => {
                  try {
                    await api.urlCategorizationRecalcUrlVisits({ limit: 100_000 });
                  } catch (e) {
                    setUrlOverridesError(String(e));
                  }
                }}
              >
                Re-categorize URL visits
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await api.urlCategorizationRecalcUrlSessions({ limit: 100_000 });
                  } catch (e) {
                    setUrlOverridesError(String(e));
                  }
                }}
              >
                Re-categorize URL sessions
              </Button>
            </SpaceBetween>

            <Table
              loading={urlOverridesLoading}
              items={urlOverridesRows}
              columnDefinitions={[
                { id: "kind", header: "Type", cell: (r) => r.kind },
                { id: "value", header: "Value", cell: (r) => r.value },
                { id: "category", header: "Category", cell: (r) => r.category_label || r.category_key },
                { id: "note", header: "Note", cell: (r) => r.note || "\u2014" },
                { id: "created", header: "Created", cell: (r) => new Date(r.created_at).toLocaleString() },
                {
                  id: "actions",
                  header: "Actions",
                  cell: (r) => (
                    <Button
                      variant="inline-icon"
                      iconName="remove"
                      onClick={async () => {
                        try {
                          await api.urlCategorizationOverridesDelete(r.kind, r.id);
                          await loadOverrides(urlOverridesQuery);
                        } catch (e) {
                          setUrlOverridesError(String(e));
                        }
                      }}
                    />
                  ),
                },
              ]}
              variant="embedded"
              empty={<Box color="text-body-secondary">No overrides yet.</Box>}
            />
          </SpaceBetween>
        </Modal>

        <Container
          header={
            <Header
              variant="h2"
              description="Total size is PostgreSQL pg_database_size (entire DB on disk). Expand to see per-table breakdown."
              actions={
                <Button iconName="refresh" onClick={loadMeta} loading={loadingMeta}>
                  Refresh usage
                </Button>
              }
            >
              Storage usage
            </Header>
          }
        >
          <SpaceBetween size="m">
            <ColumnLayout columns={3} variant="text-grid">
              <Box>
                <Box variant="awsui-key-label">Total database size</Box>
                <div>{storage ? formatBytesAdaptive(storage.database_bytes) : "\u2014"}</div>
              </Box>
              <Box>
                <Box variant="awsui-key-label">Public schema</Box>
                <div>{storage ? formatBytesAdaptive(storage.public_tables_bytes) : "\u2014"}</div>
              </Box>
              <Box>
                <Box variant="awsui-key-label">Other</Box>
                <div>{storage ? formatBytesAdaptive(storage.other_bytes) : "\u2014"}</div>
              </Box>
            </ColumnLayout>

            <ExpandableSection headerText="Details" defaultExpanded={false}>
              {storage ? (
                <SpaceBetween size="m">
                  <Box fontSize="body-s" color="text-body-secondary">
                    {storage.tables.length} relation{storage.tables.length === 1 ? "" : "s"} in{" "}
                    <Box variant="code">public</Box> (partition children are rolled into their parent&apos;s size).
                  </Box>
                  <Table
                    items={storage.tables}
                    columnDefinitions={[
                      { id: "name", header: "Relation", cell: (item) => item.name },
                      { id: "bytes", header: "Size (with indexes)", cell: (item) => formatBytesAdaptive(item.bytes) },
                    ]}
                    variant="embedded"
                  />
                </SpaceBetween>
              ) : (
                <Box color="text-body-secondary">No storage data yet.</Box>
              )}
            </ExpandableSection>
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              description="Default lock for the Windows agent's local Settings window. Agents may override per-device."
            >
              Agent local UI password (global default)
            </Header>
          }
        >
          <SpaceBetween size="m">
            {localUiSaveErr ? (
              <Alert type="error" dismissible onDismiss={() => setLocalUiSaveErr(null)}>
                {localUiSaveErr}
              </Alert>
            ) : null}
            {localUiSaveOk ? (
              <Alert type="success" dismissible onDismiss={() => setLocalUiSaveOk(null)}>
                {localUiSaveOk}
              </Alert>
            ) : null}

            {localUiPasswordSet === null && loadingMeta ? (
              <Box color="text-body-secondary">{`Loading\u2026`}</Box>
            ) : (
              <Box fontSize="body-s" color="text-body-secondary">
                Status:{" "}
                {localUiPasswordSet ? (
                  <strong>Password is set</strong>
                ) : (
                  <strong>No password</strong>
                )}
              </Box>
            )}

            <ColumnLayout columns={2}>
              <FormField
                label="New password"
                description="Leave blank to remove the global password."
                constraintText={!isAdmin ? "Administrator role required to edit." : undefined}
              >
                <Input
                  type="password"
                  value={localUiPwd}
                  disabled={!isAdmin || localUiSaving}
                  onChange={({ detail }) => setLocalUiPwd(detail.value)}
                />
              </FormField>
              <FormField label="Confirm password">
                <Input
                  type="password"
                  value={localUiPwd2}
                  disabled={!isAdmin || localUiSaving}
                  onChange={({ detail }) => setLocalUiPwd2(detail.value)}
                />
              </FormField>
            </ColumnLayout>

            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="primary"
                loading={localUiSaving}
                disabled={!isAdmin || localUiSaving}
                onClick={() => {
                  const a = localUiPwd.trim();
                  const b = localUiPwd2.trim();
                  setLocalUiSaveErr(null);
                  setLocalUiSaveOk(null);
                  if (a !== b) {
                    setLocalUiSaveErr("Passwords do not match.");
                    return;
                  }
                  if (a.length > 0 && a.length < 4) {
                    setLocalUiSaveErr("Use at least 4 characters, or leave both fields empty to remove the password.");
                    return;
                  }
                  void saveGlobalLocalUiPassword(a.length ? a : null);
                }}
              >
                Save
              </Button>
              <Button
                variant="link"
                loading={localUiSaving}
                disabled={!isAdmin || localUiSaving}
                onClick={() => {
                  setLocalUiPwd("");
                  setLocalUiPwd2("");
                  void saveGlobalLocalUiPassword(null);
                }}
              >
                Remove password
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header variant="h2" description="Tag from the latest GitHub release (same source as server Docker images).">
              About
            </Header>
          }
          footer={
            <Button
              iconName="refresh"
              loading={githubReleaseLoading}
              onClick={() => void loadGithubRelease(true)}
            >
              Check GitHub now
            </Button>
          }
        >
          <SpaceBetween size="m">
            {githubReleaseError ? (
              <Box color="text-status-error">{githubReleaseError}</Box>
            ) : null}
            {agentAutoUpdateSaveErr ? (
              <Alert type="error" dismissible onDismiss={() => setAgentAutoUpdateSaveErr(null)}>
                {agentAutoUpdateSaveErr}
              </Alert>
            ) : null}
            {agentAutoUpdateLoadErr ? (
              <Alert type="error">{agentAutoUpdateLoadErr}</Alert>
            ) : agentAutoUpdateEnabled === null && loadingMeta ? (
              <Box color="text-body-secondary">{`Loading agent auto-update policy\u2026`}</Box>
            ) : (
              <FormField
                label="Agent auto updates (global default)"
                description={
                  isAdmin
                    ? "When enabled, the server tells connected Windows agents they may check GitHub releases and install updates (policy is pushed over the WebSocket). Operators can still set a per-computer override on each agent's Settings tab."
                    : "Current default policy for Windows agents. Only administrators can change it."
                }
                constraintText={!isAdmin ? "Administrator role required to edit." : undefined}
              >
                <Toggle
                  checked={agentAutoUpdateEnabled ?? false}
                  disabled={
                    agentAutoUpdateEnabled === null || !isAdmin || agentAutoUpdateSaving || loadingMeta
                  }
                  onChange={({ detail }) => void saveGlobalAutoUpdate(detail.checked)}
                >
                  Enable agent auto updates by default
                </Toggle>
              </FormField>
            )}
            <Box>
              <Box variant="awsui-key-label">Latest GitHub release</Box>
              <div>
                {githubReleaseLoading && githubRelease == null ? `\u2026` : githubRelease?.tag ?? "\u2014"}
              </div>
              {githubRelease?.releasesUrl ? (
                <Box fontSize="body-s" margin={{ top: "xs" }} color="text-body-secondary">
                  <a href={githubRelease.releasesUrl} target="_blank" rel="noopener noreferrer">
                    Open releases on GitHub
                  </a>
                </Box>
              ) : null}
            </Box>
          </SpaceBetween>
        </Container>

      </SpaceBetween>
    </ContentLayout>
  );
}
