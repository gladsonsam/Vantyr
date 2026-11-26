import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/api";
import { ruleKeys } from "@/api/queries/rules";
import type { AlertRule, AlertRuleScope } from "@/api/types";
import type { AlertRuleBody } from "../lib/alertRuleForm";
import { channelLabel, ruleTitle } from "../lib/alertRuleSummary";

/**
 * The three changes the alert rule list makes. A refused switch change is kept as `actionError`; a refused save or
 * delete stays on its mutation so the dialog that asked for it can show it. `saved` is what last succeeded.
 */
export function useAlertRuleMutations({
  onSaved,
  onDeleted,
}: {
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const refreshRules = () => queryClient.invalidateQueries({ queryKey: ruleKeys.alertRules() });

  const toggle = useMutation({
    mutationFn: (r: AlertRule) =>
      api.alertRulesUpdate(r.id, {
        name: r.name,
        channel: r.channel,
        pattern: r.pattern,
        match_mode: r.match_mode,
        case_insensitive: r.case_insensitive,
        cooldown_secs: r.cooldown_secs,
        enabled: !r.enabled,
        take_screenshot: r.take_screenshot,
        metric: r.metric,
        comparator: r.comparator,
        threshold: r.threshold,
        duration_secs: r.duration_secs,
        scopes: (r.scopes ?? []).map((s: AlertRuleScope) => ({
          kind: s.kind,
          group_id: s.group_id,
          agent_id: s.agent_id,
        })),
      }),
    onSuccess: () => refreshRules(),
    onError: (e, r) =>
      setActionError(
        `Couldn’t turn ${r.enabled ? "off" : "on"} “${ruleTitle(r)}”: ${errorText(e)}`,
      ),
  });

  const save = useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: AlertRuleBody }) => {
      if (id === null) await api.alertRulesCreate(body);
      else await api.alertRulesUpdate(id, body);
    },
    onSuccess: async (_data, { id, body }) => {
      onSaved();
      setSaved(
        `${id === null ? "Created" : "Saved"} “${body.name || body.pattern || channelLabel(body.channel)}”.`,
      );
      await refreshRules();
    },
  });

  const remove = useMutation({
    mutationFn: (r: AlertRule) => api.alertRulesDelete(r.id),
    onSuccess: async (_data, r) => {
      onDeleted();
      setSaved(`Deleted “${ruleTitle(r)}”.`);
      await refreshRules();
    },
  });

  return { toggle, save, remove, actionError, setActionError, saved, setSaved };
}
