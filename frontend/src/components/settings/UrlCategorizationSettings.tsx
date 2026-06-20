import { useState, useEffect, useCallback } from "react";
import { Alert, Box, Button, ColumnLayout, Container, FormField, Input, Modal, ProgressBar, Select, SpaceBetween, StatusIndicator, Table, TextFilter, Toggle } from "../ui/console";
import { CategoryManagerModal } from "../CategoryManagerModal";

interface UrlCatSettingsProps {
  isAdmin: boolean;
  urlCatStatus: UrlCategorizationStatus | null;
  urlCatSaving: boolean;
  urlCatLoading: boolean;
  urlCatError: string | null;
  setUrlCatStatus: React.Dispatch<React.SetStateAction<UrlCategorizationStatus | null>>;
  saveUrlCategorization: (patch: Partial<{ enabled: boolean; auto_update: boolean; source_url: string }>) => Promise<void>;
  urlCatUpdateNow: () => Promise<void>;
  refreshUrlCategorization: () => Promise<void>;
  
  loadOverrides: (q: string) => Promise<{ id: number; kind: "domain" | "url"; value: string; category_key: string; category_label: string; note: string; created_at: string }[]>;
  loadUrlCategories: () => Promise<{ key: string; label?: string; enabled: boolean; description: string }[]>;
  onAddOverride: (body: { kind: "domain" | "url"; value: string; category_key: string; note: string }) => Promise<void>;
  onDeleteOverride: (kind: "domain" | "url", id: number) => Promise<void>;
  onRecalcUrlVisits: () => Promise<void>;
  onRecalcUrlSessions: () => Promise<void>;
}

interface UrlCategorizationStatus {
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
}

export function UrlCategorizationSettings({
  isAdmin,
  urlCatStatus,
  urlCatSaving,
  urlCatLoading,
  urlCatError,
  setUrlCatStatus,
  saveUrlCategorization,
  urlCatUpdateNow,
  refreshUrlCategorization,
  loadOverrides,
  loadUrlCategories,
  onAddOverride,
  onDeleteOverride,
  onRecalcUrlVisits,
  onRecalcUrlSessions,
}: UrlCatSettingsProps) {
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

  const fetchOverrides = useCallback(async (q: string) => {
    setUrlOverridesLoading(true);
    setUrlOverridesError(null);
    try {
      const rows = await loadOverrides(q);
      setUrlOverridesRows(rows);
    } catch (e) {
      setUrlOverridesError(String(e));
      setUrlOverridesRows([]);
    } finally {
      setUrlOverridesLoading(false);
    }
  }, [loadOverrides]);

  const fetchCategories = useCallback(async () => {
    try {
      const cats = await loadUrlCategories();
      setUrlCategories(cats);
    } catch {
      setUrlCategories([]);
    }
  }, [loadUrlCategories]);

  useEffect(() => {
    if (!urlOverridesOpen || !isAdmin) return;
    void fetchCategories();
    void fetchOverrides(urlOverridesQuery);
  }, [isAdmin, fetchOverrides, fetchCategories, urlOverridesOpen, urlOverridesQuery]);

  return (
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
              <Box>Last update</Box>
              <Box>
                {urlCatStatus?.settings.last_update_at
                  ? new Date(urlCatStatus.settings.last_update_at).toLocaleString()
                  : "\u2014"}
              </Box>
            </Box>
            <Box>
              <Box>Active sha256</Box>
              <Box variant="code">{urlCatStatus?.active_release.sha256 ?? "\u2014"}</Box>
            </Box>
            <Box>
              <Box>Counts</Box>
              <Box>{`${urlCatStatus?.counts.categories ?? 0} categories  /  ${urlCatStatus?.counts.domains.toLocaleString() ?? 0} domains  /  ${urlCatStatus?.counts.urls.toLocaleString() ?? 0} URLs`}</Box>
            </Box>
          </ColumnLayout>
          {urlCatStatus?.settings.last_update_error && (
            <StatusIndicator type="error">{urlCatStatus.settings.last_update_error}</StatusIndicator>
          )}
          {(urlCatStatus?.job?.state === "downloading" || urlCatStatus?.job?.state === "importing") && (
            <SpaceBetween size="xs">
              <StatusIndicator type="in-progress">
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
                    await onAddOverride({
                      kind: urlOverrideAddKind,
                      value: urlOverrideAddValue,
                      category_key: urlOverrideAddCategory,
                      note: urlOverrideAddNote,
                    });
                    setUrlOverrideAddValue("");
                    setUrlOverrideAddNote("");
                    await fetchOverrides(urlOverridesQuery);
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
                  void fetchOverrides(detail.filteringText);
                }}
                filteringPlaceholder="Search overrides (domain/url/category)"
              />

              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  onClick={async () => {
                    try {
                      await onRecalcUrlVisits();
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
                      await onRecalcUrlSessions();
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
                            await onDeleteOverride(r.kind, r.id);
                            await fetchOverrides(urlOverridesQuery);
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
        </SpaceBetween>
      )}
    </Container>
  );
}
