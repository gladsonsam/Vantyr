import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { urlCategoryQueries } from "@/api/queries/urlCategories";

export type UrlCategorizationStatus = Awaited<ReturnType<typeof api.urlCategorizationStatusGet>>;
export type UrlCategorizationPatch = Partial<{ enabled: boolean; auto_update: boolean; source_url: string }>;

export const DEFAULT_SOURCE_URL = "https://github.com/olbat/ut1-blacklists/archive/refs/heads/master.tar.gz";

/** A list download or import is in flight. */
export function urlCatJobRunning(status: UrlCategorizationStatus | null | undefined): boolean {
  return status?.job?.state === "downloading" || status?.job?.state === "importing";
}

/** Download/import progress as a whole percentage (0 when the total size is unknown). */
export function urlCatJobProgress(status: UrlCategorizationStatus | null | undefined): number {
  const job = status?.job;
  return job?.bytes_total && job.bytes_total > 0
    ? Math.min(100, Math.floor((job.bytes_done / job.bytes_total) * 100))
    : 0;
}

/**
 * The settings of the URL categorization feature (admin): the status query (polled every 5 s
 * while a list download/import runs and the tab is visible) and the save / "download now" actions.
 */
export function useUrlCategorization(isAdmin: boolean) {
  const query = useQuery({
    ...urlCategoryQueries.status(),
    enabled: isAdmin,
    refetchInterval: (q) => (urlCatJobRunning(q.state.data) ? 5000 : false),
    refetchIntervalInBackground: false,
  });
  const status = query.data ?? null;
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = async () => {
    if (!isAdmin) return;
    setActionError(null);
    await query.refetch();
  };

  const saveMutation = useMutation({
    mutationFn: (body: { enabled: boolean; auto_update: boolean; source_url: string }) => api.urlCategorizationSettingsPut(body),
    onSuccess: () => refresh(),
    onError: (e) => setActionError(String(e)),
  });
  const updateNowMutation = useMutation({
    mutationFn: () => api.urlCategorizationUpdateNow(),
    onSuccess: () => refresh(),
    onError: (e) => setActionError(String(e)),
  });

  const save = async (patch: UrlCategorizationPatch) => {
    if (!isAdmin) return;
    const cur = status?.settings;
    const next = {
      enabled: patch.enabled ?? cur?.enabled ?? false,
      auto_update: patch.auto_update ?? cur?.auto_update ?? true,
      source_url: (patch.source_url ?? cur?.source_url ?? DEFAULT_SOURCE_URL).trim(),
    };
    if (!next.source_url) {
      setActionError("source_url is required");
      return;
    }
    setActionError(null);
    await saveMutation.mutateAsync(next).catch(() => undefined);
  };

  const updateNow = async () => {
    if (!isAdmin) return;
    setActionError(null);
    await updateNowMutation.mutateAsync().catch(() => undefined);
  };

  return {
    status,
    /** Changes whenever a fresh status arrives; re-seeds the source URL form. */
    version: query.dataUpdatedAt,
    saving: saveMutation.isPending,
    loading: updateNowMutation.isPending || (query.isFetching && !query.isPending),
    error: actionError ?? (query.error ? String(query.error) : null),
    clearError: () => setActionError(null),
    save,
    updateNow,
    refresh,
  };
}

export type UrlCategorization = ReturnType<typeof useUrlCategorization>;
