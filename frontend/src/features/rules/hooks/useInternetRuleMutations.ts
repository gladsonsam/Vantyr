import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/api";
import { ruleKeys, ruleQueries } from "@/api/queries/rules";
import type { InternetBlockRule } from "@/api/types";
import type { InternetBlockRuleBody } from "../lib/internetBlockForm";
import type { ScheduleWindow } from "../lib/scheduleRows";

export const internetRuleTitle = (r: { name: string }) => r.name || "Internet block";

/**
 * The changes the internet block list makes. A refused switch is kept as `actionError`; a refused create,
 * schedule save or delete stays on its mutation so the dialog that asked for it can show it.
 */
export function useInternetRuleMutations({ onCreated, onScheduleSaved, onDeleted, onToggled }: {
  onCreated: () => void;
  onScheduleSaved: () => void;
  onDeleted: () => void;
  onToggled: () => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const listKey = ruleQueries.internetBlockRules().queryKey;
  const refreshRules = () => queryClient.invalidateQueries({ queryKey: ruleKeys.internetBlockRules() });

  const create = useMutation({
    mutationFn: (body: InternetBlockRuleBody) => api.internetBlockRulesCreate(body),
    onSuccess: async (_data, body) => {
      onCreated();
      setSaved(`Added “${internetRuleTitle({ name: body.name ?? "" })}”.`);
      await refreshRules();
    },
  });

  const toggle = useMutation({
    mutationFn: (r: InternetBlockRule) => api.internetBlockRulesUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: (_, r) => {
      queryClient.setQueryData(listKey, (prev) => prev && { ...prev, rules: prev.rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) });
      onToggled();
    },
    onError: (e, r) => {
      onToggled();
      setActionError(`Couldn’t turn ${r.enabled ? "off" : "on"} “${internetRuleTitle(r)}”: ${errorText(e)}`);
    },
  });

  const scheduleSave = useMutation({
    mutationFn: ({ rule, schedules }: { rule: InternetBlockRule; schedules: ScheduleWindow[] }) =>
      api.internetBlockRulesUpdate(rule.id, { enabled: rule.enabled, schedules }),
    onSuccess: async (_data, { rule }) => {
      onScheduleSaved();
      setSaved(`Saved the schedule of “${internetRuleTitle(rule)}”.`);
      await refreshRules();
    },
  });

  const remove = useMutation({
    mutationFn: (r: InternetBlockRule) => api.internetBlockRulesDelete(r.id),
    onSuccess: (_, r) => {
      queryClient.setQueryData(listKey, (prev) => prev && { ...prev, rules: prev.rules.filter((x) => x.id !== r.id) });
      onDeleted();
      setSaved(`Deleted “${internetRuleTitle(r)}”.`);
    },
  });

  return { create, toggle, scheduleSave, remove, actionError, setActionError, saved, setSaved };
}
