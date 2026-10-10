import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { resolveDateRangeToDayBounds, type ActivityDateValue } from "./activityDateRange";
import {
  applyActivityStateToSearchParams,
  encodeActivityState,
  readActivityStateFromSearchParams,
  type ActivityUrlStateV1,
} from "./activityUrl";

export type ActivityFilters = ReturnType<typeof useActivityFilters>;

/**
 * Activity timeline filters (search, alerts only, app, date range). With an `agentId` they are
 * kept in sync with `?activity=` so filtered views are shareable and deep links apply on load.
 */
export function useActivityFilters(agentId: string | undefined) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSyncEnabled = Boolean(agentId);

  const [searchQuery, setSearchQuery] = useState("");
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [appFilterExe, setAppFilterExe] = useState<string | null>(null);
  const [jumpRangeValue, setJumpRangeValue] = useState<ActivityDateValue>(null);

  const lastUrlActivityRawRef = useRef<string | null>(null);
  const skipActivityUrlPushRef = useRef(false);

  const buildActivityStateFromUi = useCallback((): ActivityUrlStateV1 | null => {
    const q = searchQuery.trim();
    const app = appFilterExe?.trim() ? appFilterExe.trim() : null;
    const bounds = resolveDateRangeToDayBounds(jumpRangeValue);
    const from = bounds?.start ?? null;
    const to = bounds?.end ?? null;
    if (!q && !alertsOnly && !app && !from && !to) return null;
    return {
      v: 1,
      q: q || undefined,
      alerts: alertsOnly ? true : undefined,
      app,
      from,
      to,
    };
  }, [searchQuery, alertsOnly, appFilterExe, jumpRangeValue]);

  const applyActivityStateToUi = useCallback((s: ActivityUrlStateV1 | null) => {
    if (!s) {
      setSearchQuery("");
      setAlertsOnly(false);
      setAppFilterExe(null);
      setJumpRangeValue(null);
      return;
    }
    setSearchQuery(s.q ?? "");
    setAlertsOnly(Boolean(s.alerts));
    setAppFilterExe(s.app ?? null);
    if (s.from && s.to) {
      setJumpRangeValue({
        type: "absolute",
        startDate: s.from,
        endDate: s.to,
      });
    } else {
      setJumpRangeValue(null);
    }
  }, []);

  // Apply `?activity=` from the URL into UI state (deep links).
  useEffect(() => {
    if (!urlSyncEnabled) return;
    const raw = searchParams.get("activity");
    if (raw === lastUrlActivityRawRef.current) return;
    lastUrlActivityRawRef.current = raw;
    const decoded = readActivityStateFromSearchParams(searchParams);
    skipActivityUrlPushRef.current = true;
    applyActivityStateToUi(decoded);
  }, [urlSyncEnabled, searchParams, applyActivityStateToUi]);

  // Push UI state into the URL (shareable), without clobbering unrelated params.
  useEffect(() => {
    if (!urlSyncEnabled) return;
    if (skipActivityUrlPushRef.current) {
      skipActivityUrlPushRef.current = false;
      return;
    }
    const nextState = buildActivityStateFromUi();
    const encoded = nextState ? encodeActivityState(nextState) : null;
    const current = searchParams.get("activity");
    if (encoded === current) return;

    setSearchParams((prev) => applyActivityStateToSearchParams(prev, nextState), { replace: true });
    lastUrlActivityRawRef.current = encoded;
  }, [urlSyncEnabled, buildActivityStateFromUi, setSearchParams, searchParams]);

  const deepLinkToActivity = useCallback(
    (patch: ActivityUrlStateV1) => {
      if (!agentId) return;
      const qs = applyActivityStateToSearchParams(new URLSearchParams(), patch);
      navigate(`/agents/${agentId}?${qs.toString()}`);
    },
    [agentId, navigate],
  );

  /** Clicking an app filters to it; clicking the same app again clears the filter. */
  const toggleAppFilter = useCallback((exe: string) => {
    setAppFilterExe((prev) => (prev?.toLowerCase() === exe.toLowerCase() ? null : exe));
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setAlertsOnly(false);
    setAppFilterExe(null);
    setJumpRangeValue(null);
    if (urlSyncEnabled) {
      skipActivityUrlPushRef.current = true;
      lastUrlActivityRawRef.current = null;
      setSearchParams((prev) => applyActivityStateToSearchParams(prev, null), { replace: true });
    }
  }, [urlSyncEnabled, setSearchParams]);

  const isFiltered =
    searchQuery.trim().length > 0 || alertsOnly || jumpRangeValue != null || Boolean(appFilterExe);

  return {
    searchQuery,
    setSearchQuery,
    alertsOnly,
    setAlertsOnly,
    appFilterExe,
    setAppFilterExe,
    toggleAppFilter,
    jumpRangeValue,
    setJumpRangeValue,
    isFiltered,
    clearFilters,
    deepLinkToActivity,
  };
}
