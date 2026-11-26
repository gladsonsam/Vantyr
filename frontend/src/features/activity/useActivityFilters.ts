import { useCallback, useMemo, useState, type SetStateAction } from "react";
import { useAgentToolsPath } from "@/features/agent-detail/agentToolsPath";
import { useNavigate, useSearchParams } from "react-router-dom";
import { resolveDateRangeToDayBounds, type ActivityDateValue } from "./activityDateRange";
import {
  applyActivityStateToSearchParams,
  readActivityStateFromSearchParams,
  type ActivityUrlStateV1,
} from "./activityUrl";

export type ActivityFilters = ReturnType<typeof useActivityFilters>;
type FilterValues = {
  searchQuery: string;
  alertsOnly: boolean;
  appFilterExe: string | null;
  jumpRangeValue: ActivityDateValue;
};
const EMPTY_FILTERS: FilterValues = {
  searchQuery: "",
  alertsOnly: false,
  appFilterExe: null,
  jumpRangeValue: null,
};
function valuesFromUrl(params: URLSearchParams): FilterValues {
  const state = readActivityStateFromSearchParams(params);
  return {
    searchQuery: state?.q ?? "",
    alertsOnly: Boolean(state?.alerts),
    appFilterExe: state?.app ?? null,
    jumpRangeValue:
      state?.from && state.to
        ? { type: "absolute", startDate: state.from, endDate: state.to }
        : null,
  };
}
function urlState(values: FilterValues): ActivityUrlStateV1 | null {
  const bounds = resolveDateRangeToDayBounds(values.jumpRangeValue);
  const app = values.appFilterExe?.trim() || null;
  if (!values.searchQuery.trim() && !values.alertsOnly && !app && !bounds) return null;
  // Preserve the draft's whitespace while typing a multiword search.
  return {
    v: 1,
    q: values.searchQuery || undefined,
    alerts: values.alertsOnly || undefined,
    app,
    from: bounds?.start ?? null,
    to: bounds?.end ?? null,
  };
}
function updateValue<K extends keyof FilterValues>(
  values: FilterValues,
  key: K,
  action: SetStateAction<FilterValues[K]>,
): FilterValues {
  const next =
    typeof action === "function"
      ? (action as (previous: FilterValues[K]) => FilterValues[K])(values[key])
      : action;
  return { ...values, [key]: next };
}

/** The URL owns device filters, so navigation never needs an effect to copy them into state. */
export function useActivityFilters(agentId: string | undefined) {
  const navigate = useNavigate();
  const toolsPath = useAgentToolsPath(agentId ?? "");
  const [searchParams, setSearchParams] = useSearchParams();
  const [local, setLocal] = useState(EMPTY_FILTERS);
  const fromUrl = useMemo(() => valuesFromUrl(searchParams), [searchParams]);
  const values = agentId ? fromUrl : local;
  const update = useCallback(
    <K extends keyof FilterValues>(key: K, action: SetStateAction<FilterValues[K]>) => {
      if (agentId) {
        setSearchParams(
          (previous) =>
            applyActivityStateToSearchParams(
              previous,
              urlState(updateValue(valuesFromUrl(previous), key, action)),
            ),
          { replace: true },
        );
      } else setLocal((previous) => updateValue(previous, key, action));
    },
    [agentId, setSearchParams],
  );
  const setSearchQuery = useCallback(
    (action: SetStateAction<string>) => update("searchQuery", action),
    [update],
  );
  const setAlertsOnly = useCallback(
    (action: SetStateAction<boolean>) => update("alertsOnly", action),
    [update],
  );
  const setAppFilterExe = useCallback(
    (action: SetStateAction<string | null>) => update("appFilterExe", action),
    [update],
  );
  const setJumpRangeValue = useCallback(
    (action: SetStateAction<ActivityDateValue>) => update("jumpRangeValue", action),
    [update],
  );
  const toggleAppFilter = useCallback(
    (exe: string) =>
      setAppFilterExe((previous) => (previous?.toLowerCase() === exe.toLowerCase() ? null : exe)),
    [setAppFilterExe],
  );
  const clearFilters = useCallback(() => {
    if (agentId)
      setSearchParams((previous) => applyActivityStateToSearchParams(previous, null), {
        replace: true,
      });
    else setLocal(EMPTY_FILTERS);
  }, [agentId, setSearchParams]);
  const deepLinkToActivity = useCallback(
    (patch: ActivityUrlStateV1) => {
      if (!agentId) return;
      navigate(
        `${toolsPath}?${applyActivityStateToSearchParams(new URLSearchParams(), patch).toString()}`,
      );
    },
    [agentId, navigate, toolsPath],
  );
  const isFiltered =
    values.searchQuery.trim().length > 0 ||
    values.alertsOnly ||
    values.jumpRangeValue != null ||
    Boolean(values.appFilterExe);
  return {
    ...values,
    setSearchQuery,
    setAlertsOnly,
    setAppFilterExe,
    setJumpRangeValue,
    toggleAppFilter,
    clearFilters,
    deepLinkToActivity,
    isFiltered,
  };
}
