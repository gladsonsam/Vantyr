import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { ruleKeys } from "@/api/queries/rules";
import type { AgentGroup } from "@/api/types";
import { RuleModal } from "./RuleModal";
import { newRuleForGroup, ruleRequestBody } from "./groupRule";
import type { GroupRuleValues } from "./groupSchemas";

interface GroupRuleDialogProps {
  /** The group the new rule targets; the dialog is closed while this is null. */
  group: AgentGroup | null;
  agentOptions: { label: string; value: string }[];
  groupOptions: { label: string; value: string }[];
  onDismiss: () => void;
}

/** "New alert rule for this group": the rule form prefilled to target the group, saved through the rules API. A failed save is reported inside the form. */
export function GroupRuleDialog({ group, agentOptions, groupOptions, onDismiss }: GroupRuleDialogProps) {
  const queryClient = useQueryClient();
  const createRule = useMutation({
    mutationFn: (body: Parameters<typeof api.alertRulesCreate>[0]) => api.alertRulesCreate(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ruleKeys.alertRules() }),
  });

  const save = async (data: GroupRuleValues) => {
    await createRule.mutateAsync(ruleRequestBody(data));
  };

  return (
    <RuleModal
      visible={group !== null}
      onDismiss={onDismiss}
      rule={group ? newRuleForGroup(group.id, group.name) : null}
      heading={group ? `New alert rule for ${group.name}` : undefined}
      agentOptions={agentOptions}
      groupOptions={groupOptions}
      onSave={save}
    />
  );
}
