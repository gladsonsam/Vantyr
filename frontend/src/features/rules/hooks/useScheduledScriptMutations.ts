import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/api";
import { ruleKeys } from "@/api/queries/rules";
import type { ScheduledScript } from "@/api/types";
import type { ScheduledScriptBody } from "../lib/scheduledScriptForm";

/**
 * The changes the scheduled script list makes. A refused switch or run is kept as `actionError`; a refused
 * save or delete stays on its mutation so the dialog that asked for it can show it. `saved` is what last succeeded.
 */
export function useScheduledScriptMutations({ onSaved, onDeleted, onRunRequested }: { onSaved: () => void; onDeleted: () => void; onRunRequested: () => void }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Scripts and their run feed share the `scheduledScripts` key prefix, so this reloads both.
  const refreshScripts = () => queryClient.invalidateQueries({ queryKey: ruleKeys.scheduledScripts() });

  const save = useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: ScheduledScriptBody }) => {
      if (id === null) await api.scheduledScriptsCreate(body);
      else await api.scheduledScriptsUpdate(id, body);
    },
    onSuccess: async (_data, { id, body }) => {
      onSaved();
      setSaved(`${id === null ? "Added" : "Saved"} “${body.name}”.`);
      await refreshScripts();
    },
  });

  const remove = useMutation({
    mutationFn: (r: ScheduledScript) => api.scheduledScriptsDelete(r.id),
    onSuccess: async (_data, r) => {
      onDeleted();
      setSaved(`Deleted “${r.name}”.`);
      await refreshScripts();
    },
  });

  const toggle = useMutation({
    mutationFn: (r: ScheduledScript) => api.scheduledScriptsUpdate(r.id, { enabled: !r.enabled }),
    onSuccess: () => refreshScripts(),
    onError: (e, r) => setActionError(`Couldn’t turn ${r.enabled ? "off" : "on"} “${r.name}”: ${errorText(e)}`),
  });

  const trigger = useMutation({
    mutationFn: (r: ScheduledScript) => api.scheduledScriptsTrigger(r.id),
    onSuccess: async (res, r) => {
      onRunRequested();
      setSaved(
        `Sent “${r.name}” to its ${res.agent_count} ${res.agent_count === 1 ? "device" : "devices"}. Offline devices skip it; results appear in Run history.`,
      );
      await refreshScripts();
    },
    onError: (e, r) => {
      onRunRequested();
      setActionError(`Couldn’t run “${r.name}”: ${errorText(e)}`);
    },
  });

  return { save, remove, toggle, trigger, actionError, setActionError, saved, setSaved };
}
