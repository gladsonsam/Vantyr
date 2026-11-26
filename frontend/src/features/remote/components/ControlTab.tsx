import { Info } from "lucide-react";
import { Alert, AlertTitle } from "@vantyr/ui/components/alert";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/api";
import { ruleKeys, ruleQueries } from "@/api/queries/rules";
import type { AgentInfo, AppBlockRule } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { AppBlockModal } from "./AppBlockModal";
import {
  AppRulesSection,
  BlockInternetDialog,
  DeleteRuleDialog,
  InternetSection,
} from "./BlockingSections";

interface ControlTabProps {
  agentId: string;
  agentName: string;
  agentOnline: boolean;
  isAdmin: boolean;
  agentInfo?: AgentInfo | null;
  sendWsMessage: (msg: unknown) => void;
}

const NO_RULES: AppBlockRule[] = [];

const toRules = (r: { rules: AppBlockRule[] }) => r.rules;

/** Blocking: the device's internet policy and the apps that are closed on it (admins only). */
export function ControlTab({
  agentId,
  agentName,
  agentOnline,
  isAdmin,
  agentInfo,
}: ControlTabProps) {
  const queryClient = useQueryClient();
  const [confirmingBlock, setConfirmingBlock] = useState(false);

  // ── Internet access ──────────────────────────────────────────────────────────
  // Same key as the agent vitals card, so a change here updates both. The state shown is only ever
  // what the server last confirmed.
  const netQuery = useQuery(ruleQueries.internetBlocked(agentId));
  const netPolicy = useMutation({
    mutationFn: (vars: { agentId: string; blocked: boolean }) =>
      api.agentInternetBlockedPut(vars.agentId, { blocked: vars.blocked }),
    onSuccess: (r, vars) => queryClient.setQueryData(ruleKeys.internetBlocked(vars.agentId), r),
  });
  const setInternetBlocked = (blocked: boolean) =>
    netPolicy.mutate({ agentId, blocked }, { onSettled: () => setConfirmingBlock(false) });

  // ── App blocking ─────────────────────────────────────────────────────────────
  const rulesQuery = useQuery({ ...ruleQueries.appBlockRulesForAgent(agentId), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;
  // Toggle/delete failures; cleared when the list is reloaded (another agent, or a rule was added).
  const [mutationErr, setMutationErr] = useState<string | null>(null);
  const [errAgentId, setErrAgentId] = useState(agentId);
  if (agentId !== errAgentId) {
    setErrAgentId(agentId);
    setMutationErr(null);
  }
  const rulesErr = mutationErr ?? (rulesQuery.error ? errorText(rulesQuery.error) : null);
  const [showModal, setShowModal] = useState(false);
  const [deletingRule, setDeletingRule] = useState<AppBlockRule | null>(null);

  const reloadRules = () => {
    setMutationErr(null);
    void queryClient.invalidateQueries({ queryKey: ruleKeys.appBlockRules() });
  };

  /** Patch this agent's cached rule list after the server confirmed a change. */
  const patchRules = (forAgent: string, update: (rules: AppBlockRule[]) => AppBlockRule[]) =>
    queryClient.setQueryData(
      ruleQueries.appBlockRulesForAgent(forAgent).queryKey,
      (prev) => prev && { ...prev, rules: update(prev.rules) },
    );

  const toggle = useMutation({
    mutationFn: (vars: { agentId: string; rule: AppBlockRule }) =>
      api.appBlockRulesUpdate(vars.rule.id, { enabled: !vars.rule.enabled }),
    onSuccess: (_, { agentId: forAgent, rule }) =>
      patchRules(forAgent, (prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)),
      ),
    onError: (e) => setMutationErr(errorText(e)),
  });
  const togglingId = toggle.isPending ? toggle.variables.rule.id : null;

  const remove = useMutation({
    mutationFn: (vars: { agentId: string; rule: AppBlockRule }) =>
      api.appBlockRulesDelete(vars.rule.id),
    onSuccess: (_, { agentId: forAgent, rule }) =>
      patchRules(forAgent, (prev) => prev.filter((r) => r.id !== rule.id)),
    onError: (e) => setMutationErr(errorText(e)),
    onSettled: () => setDeletingRule(null),
  });
  const deletingId = remove.isPending ? remove.variables.rule.id : null;

  if (!isAdmin) {
    return (
      <Alert>
        <Info />
        <AlertTitle>Admin only.</AlertTitle>
      </Alert>
    );
  }

  const networkAvailable = capabilityAvailable(agentInfo, "network_blocking");
  const appBlockAvailable = capabilityAvailable(agentInfo, "app_blocking");
  const netStatus = netQuery.data;

  return (
    <div className="flex flex-col gap-4">
      <InternetSection
        loading={netQuery.isPending}
        loadFailed={netQuery.isError}
        blocked={netStatus?.blocked ?? false}
        source={netStatus?.source ?? null}
        saving={netPolicy.isPending}
        available={networkAvailable}
        online={agentOnline}
        info={agentInfo}
        error={netPolicy.error ? errorText(netPolicy.error) : null}
        onReload={() => void netQuery.refetch()}
        onAllow={() => setInternetBlocked(false)}
        onAskBlock={() => setConfirmingBlock(true)}
      />

      <AppRulesSection
        agentId={agentId}
        loading={rulesQuery.isFetching}
        rules={rules}
        available={appBlockAvailable}
        info={agentInfo}
        error={rulesErr}
        togglingId={togglingId}
        deletingId={deletingId}
        onReload={reloadRules}
        onAdd={() => setShowModal(true)}
        onToggle={(rule) => toggle.mutate({ agentId, rule })}
        onAskDelete={setDeletingRule}
      />

      <AppBlockModal
        visible={showModal}
        agentId={agentId}
        agentName={agentName}
        onDismiss={() => setShowModal(false)}
        onCreated={reloadRules}
      />

      <BlockInternetDialog
        open={confirmingBlock}
        agentName={agentName}
        online={agentOnline}
        saving={netPolicy.isPending}
        onCancel={() => setConfirmingBlock(false)}
        onConfirm={() => setInternetBlocked(true)}
      />

      <DeleteRuleDialog
        rule={deletingRule}
        deleting={deletingId !== null}
        onCancel={() => setDeletingRule(null)}
        onConfirm={(rule) => remove.mutate({ agentId, rule })}
      />
    </div>
  );
}
