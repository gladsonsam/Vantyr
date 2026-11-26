import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/api";
import { ruleKeys, ruleQueries } from "@/api/queries/rules";
import type { AppBlockRule } from "@/api/types";
import type { AppBlockRuleBody } from "../lib/appBlockForm";

export const appBlockTitle = (r: AppBlockRule) => r.name || r.exe_pattern;

/**
 * The changes the app block list makes. A refused switch is kept as `actionError`; a refused save or delete
 * stays on its mutation so the dialog that asked for it can show it. `saved` is what last succeeded.
 */
export function useAppBlockMutations({
  onSaved,
  onDeleted,
}: {
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const listKey = ruleQueries.appBlockRules().queryKey;

  const toggle = useMutation({
    mutationFn: (r: AppBlockRule) => api.appBlockRulesUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: (_, r) =>
      queryClient.setQueryData(
        listKey,
        (prev) =>
          prev && {
            ...prev,
            rules: prev.rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)),
          },
      ),
    onError: (e, r) =>
      setActionError(
        `Couldn’t turn ${r.enabled ? "off" : "on"} “${appBlockTitle(r)}”: ${errorText(e)}`,
      ),
  });

  const save = useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: AppBlockRuleBody }) => {
      if (id === null) await api.appBlockRulesCreate(body);
      else await api.appBlockRulesUpdate(id, body);
    },
    onSuccess: async (_data, { id, body }) => {
      onSaved();
      setSaved(`${id === null ? "Added" : "Saved"} “${body.name || body.exe_pattern}”.`);
      await queryClient.invalidateQueries({ queryKey: ruleKeys.appBlockRules() });
    },
  });

  const remove = useMutation({
    mutationFn: (r: AppBlockRule) => api.appBlockRulesDelete(r.id),
    onSuccess: (_, r) => {
      queryClient.setQueryData(
        listKey,
        (prev) => prev && { ...prev, rules: prev.rules.filter((x) => x.id !== r.id) },
      );
      onDeleted();
      setSaved(`Deleted “${appBlockTitle(r)}”.`);
    },
  });

  return { toggle, save, remove, actionError, setActionError, saved, setSaved };
}
