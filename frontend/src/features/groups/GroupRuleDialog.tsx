import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { ruleKeys } from "@/api/queries/rules";
import type { AgentGroup } from "@/api/types";
import { RuleModal } from "./RuleModal";
import { newRuleForGroup, ruleRequestBody } from "./groupRule";
import type { GroupRuleValues } from "./groupSchemas";
import { messageOf } from "./groupSummary";

interface GroupRuleDialogProps {
  /** The group the new rule targets; the dialog is closed while this is null. */
  group: AgentGroup | null;
  agentOptions: { label: string; value: string }[];
  groupOptions: { label: string; value: string }[];
  onDismiss: () => void;
  /** A failed save, reported where the page shows its errors. */
  onError: (message: string | null) => void;
}

/** "New alert rule for this group": the rule form prefilled to target the group, saved through the rules API. */
export function GroupRuleDialog({ group, agentOptions, groupOptions, onDismiss, onError }: GroupRuleDialogProps) {
  const queryClient = useQueryClient();
  const createRule = useMutation({
    mutationFn: (body: Parameters<typeof api.alertRulesCreate>[0]) => api.alertRulesCreate(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ruleKeys.alertRules() }),
  });

  const save = async (data: GroupRuleValues) => {
    onError(null);
    try {
      await createRule.mutateAsync(ruleRequestBody(data));
    } catch (e: unknown) {
      onError(messageOf(e));
      throw e;
    }
  };

  return (
    <RuleModal
      visible={group !== null}
      onDismiss={onDismiss}
      rule={group ? newRuleForGroup(group.id, group.name) : null}
      agentOptions={agentOptions}
      groupOptions={groupOptions}
      onSave={save}
    />
  );
}
