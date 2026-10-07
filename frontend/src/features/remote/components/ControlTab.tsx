import { Info, TriangleAlert, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vantyr/ui/components/table";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router-dom";
import { api } from "@/api";
import { ruleKeys, ruleQueries } from "@/api/queries/rules";
import type { AgentInfo, AppBlockRule } from "@/api/types";
import { AppIcon } from "@/components/common/AppIcon";
import { AppBlockModal } from "./AppBlockModal";
import { capabilityAvailable, capabilityNeedsCaution, capabilityStatus } from "@/features/agent-detail/lib/agentCapabilities";
import { cn } from "@/lib/utils";

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

function StatusWord({ blocked }: { blocked: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px]">
      <span className={cn("size-[7px] rounded-full", blocked ? "bg-warning" : "bg-success")} aria-hidden="true" />
      <span className={blocked ? "text-warning" : "text-success"}>{blocked ? "Blocked" : "Allowed"}</span>
    </span>
  );
}

function ScopeWord({ kind }: { kind: string }) {
  if (kind === "all") return <span>All devices</span>;
  if (kind === "group") return <span>Group</span>;
  return <span className="text-muted-foreground">This device</span>;
}

export function ControlTab({ agentId, agentName, agentOnline, isAdmin, agentInfo }: ControlTabProps) {
  const queryClient = useQueryClient();

  // ── Internet access ──────────────────────────────────────────────────────────
  // Same key as the agent vitals card, so a toggle here updates both. A failed load reads as "Allowed".
  const netQuery = useQuery(ruleQueries.internetBlocked(agentId));
  const netBlocked = netQuery.data?.blocked ?? false;
  const netSource = netQuery.data?.source ?? null;
  const netLoad = netQuery.isPending;

  const netPolicy = useMutation({
    mutationFn: (vars: { agentId: string; blocked: boolean }) =>
      api.agentInternetBlockedPut(vars.agentId, { blocked: vars.blocked }),
    onSuccess: (r, vars) => queryClient.setQueryData(ruleKeys.internetBlocked(vars.agentId), r),
  });
  const netSave = netPolicy.isPending;
  const netErr = netPolicy.error ? String(netPolicy.error) : null;

  const applyNetworkPolicy = (blocked: boolean) => netPolicy.mutate({ agentId, blocked });

  const sourceLabel = (src: string | null) => {
    if (src === "all") return "all devices rule";
    if (src === "group") return "group rule";
    return null;
  };

  // ── App blocking ─────────────────────────────────────────────────────────────
  const rulesQuery = useQuery({ ...ruleQueries.appBlockRulesForAgent(agentId), select: toRules });
  const rules = rulesQuery.data ?? NO_RULES;
  const rulesLoad = rulesQuery.isFetching;
  // Toggle/delete failures; cleared when the list is reloaded (another agent, or a rule was added).
  const [mutationErr, setMutationErr] = useState<string | null>(null);
  const [errAgentId, setErrAgentId] = useState(agentId);
  if (agentId !== errAgentId) {
    setErrAgentId(agentId);
    setMutationErr(null);
  }
  const rulesErr = mutationErr ?? (rulesQuery.error ? String(rulesQuery.error) : null);
  const [showModal, setShowModal] = useState(false);
  const [deletingRule, setDeletingRule] = useState<AppBlockRule | null>(null);

  const reloadRules = () => {
    setMutationErr(null);
    void queryClient.invalidateQueries({ queryKey: ruleKeys.appBlockRules() });
  };

  /** Patch this agent's cached rule list after the server confirmed a change. */
  const patchRules = (forAgent: string, update: (rules: AppBlockRule[]) => AppBlockRule[]) =>
    queryClient.setQueryData(ruleQueries.appBlockRulesForAgent(forAgent).queryKey, (prev) =>
      prev && { ...prev, rules: update(prev.rules) });

  const toggle = useMutation({
    mutationFn: (vars: { agentId: string; rule: AppBlockRule }) =>
      api.appBlockRulesUpdate(vars.rule.id, { enabled: !vars.rule.enabled }),
    onSuccess: (_, { agentId: forAgent, rule }) =>
      patchRules(forAgent, (prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r)),
    onError: (e) => setMutationErr(String(e)),
  });
  const togglingId = toggle.isPending ? toggle.variables.rule.id : null;

  const remove = useMutation({
    mutationFn: (vars: { agentId: string; rule: AppBlockRule }) => api.appBlockRulesDelete(vars.rule.id),
    onSuccess: (_, { agentId: forAgent, rule }) => patchRules(forAgent, (prev) => prev.filter((r) => r.id !== rule.id)),
    onError: (e) => setMutationErr(String(e)),
    onSettled: () => setDeletingRule(null),
  });
  const deletingId = remove.isPending ? remove.variables.rule.id : null;

  const toggleRule = (rule: AppBlockRule) => toggle.mutate({ agentId, rule });

  const deleteRule = (rule: AppBlockRule) => remove.mutate({ agentId, rule });

  const resolvedScopeKind = (rule: AppBlockRule) =>
    rule.scope_kind ?? rule.scopes?.[0]?.kind ?? "agent";

  const networkAvailable = capabilityAvailable(agentInfo, "network_blocking");
  const appBlockAvailable = capabilityAvailable(agentInfo, "app_blocking");
  const networkCaution = capabilityNeedsCaution(agentInfo, "network_blocking");
  const appBlockCaution = capabilityNeedsCaution(agentInfo, "app_blocking");

  if (!isAdmin) {
    return (
      <Alert>
        <Info />
        <AlertTitle>Admin only.</AlertTitle>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Internet access ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Internet access</CardTitle>
            <CardDescription>
              Managed in <RouterLink to="/rules?tab=internet-access" className="text-primary hover:underline">Rules</RouterLink>
            </CardDescription>
          </div>
          {!netLoad && <StatusWord blocked={netBlocked} />}
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-2">
          {!agentOnline && (
            <Alert>
              <TriangleAlert />
              <AlertDescription>
                Agent offline. Applies on reconnect.
              </AlertDescription>
            </Alert>
          )}
          {!networkAvailable && (
            <Alert>
              <Info />
              <AlertTitle>Network blocking unavailable</AlertTitle>
              <AlertDescription>
                Status: <code>{capabilityStatus(agentInfo, "network_blocking") ?? "unsupported"}</code>
              </AlertDescription>
            </Alert>
          )}
          {networkAvailable && networkCaution && (
            <Alert>
              <Info />
              <AlertTitle>May need host privileges</AlertTitle>
              <AlertDescription>
                Status: <code>{capabilityStatus(agentInfo, "network_blocking")}</code>
              </AlertDescription>
            </Alert>
          )}
          {netErr && (
            <Alert variant="destructive">
              <AlertDescription>{netErr}</AlertDescription>
            </Alert>
          )}
          {netLoad ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={netBlocked}
                  disabled={!networkAvailable || netSave || (netBlocked && netSource !== null && netSource !== "agent")}
                  onCheckedChange={(checked) => applyNetworkPolicy(checked === true)}
                  aria-label="Block internet"
                />
                Block internet
              </label>
              {netBlocked && sourceLabel(netSource) && (
                <p className="text-sm text-muted-foreground">
                  Set by a {sourceLabel(netSource)}.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── App blocking ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>App blocking</CardTitle>
          <Button variant="outline" size="sm" disabled={!appBlockAvailable} onClick={() => setShowModal(true)}>
            <Plus /> Add rule
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!appBlockAvailable && (
            <Alert>
              <Info />
              <AlertTitle>App blocking unavailable</AlertTitle>
              <AlertDescription>
                Status: <code>{capabilityStatus(agentInfo, "app_blocking") ?? "unsupported"}</code>
              </AlertDescription>
            </Alert>
          )}
          {appBlockAvailable && appBlockCaution && (
            <Alert>
              <Info />
              <AlertTitle>App blocking is limited</AlertTitle>
              <AlertDescription>
                This agent reports app blocking as <code>{capabilityStatus(agentInfo, "app_blocking")}</code>.
              </AlertDescription>
            </Alert>
          )}
          {rulesErr && (
            <Alert variant="destructive">
              <AlertDescription>{rulesErr}</AlertDescription>
            </Alert>
          )}
          <div className="overflow-hidden rounded-xl bg-muted/50">
            <Table>
              <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead>App</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                {rulesLoad && rules.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4}>
                      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                        <Spinner /> Loading…
                      </div>
                    </TableCell>
                  </TableRow>
                ) : rules.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4}>
                      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                        No rules.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <AppIcon agentId={agentId} exeName={r.exe_pattern} size={18} />
                          <span className="font-mono text-[13px]">{r.exe_pattern}</span>
                          <span className="text-xs text-muted-foreground">{r.match_mode}</span>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <ScopeWord kind={resolvedScopeKind(r)} />
                      </TableCell>
                      <TableCell>
                        <Checkbox
                          checked={r.enabled}
                          disabled={!appBlockAvailable || togglingId === r.id}
                          onCheckedChange={() => toggleRule(r)}
                          aria-label={`${r.enabled ? "Disable" : "Enable"} rule for ${r.exe_pattern}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete rule for ${r.exe_pattern}`}
                          disabled={deletingId === r.id}
                          onClick={() => setDeletingRule(r)}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── Send notification ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Notifications</CardTitle>
            <CardDescription>Desktop toast on the device.</CardDescription>
          </div>
          <RouterLink
            to={`/agents/${encodeURIComponent(agentId)}?tab=live`}
            className="inline-flex min-h-9 items-center px-3 text-sm text-primary hover:underline"
          >
            Live control
          </RouterLink>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {agentOnline
              ? "Take control in live view to send one."
              : "Agent offline."}
          </p>
        </CardContent>
      </Card>

      <AppBlockModal
        visible={showModal}
        agentId={agentId}
        agentName={agentName}
        onDismiss={() => setShowModal(false)}
        onCreated={reloadRules}
      />

      <AlertDialog open={deletingRule !== null} onOpenChange={(open) => { if (!open) setDeletingRule(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete block rule?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deletingRule?.name || deletingRule?.exe_pattern}” will no longer be blocked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletingId !== null}
              onClick={() => { if (deletingRule) deleteRule(deletingRule); }}
            >
              {deletingId !== null && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
