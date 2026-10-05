import { Info, TriangleAlert, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useState, useEffect, useCallback } from "react";
import { Link as RouterLink } from "react-router-dom";
import { api } from "../../lib/api";
import type { AgentInfo, AppBlockRule } from "../../lib/types";
import { AppIcon } from "../common/AppIcon";
import { AppBlockModal } from "./AppBlockModal";
import { capabilityAvailable, capabilityNeedsCaution, capabilityStatus } from "../../lib/agentCapabilities";
import { cn } from "@/lib/utils";

interface ControlTabProps {
  agentId: string;
  agentName: string;
  agentOnline: boolean;
  isAdmin: boolean;
  agentInfo?: AgentInfo | null;
  sendWsMessage: (msg: unknown) => void;
}

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
  // ── Internet access ──────────────────────────────────────────────────────────
  const [netBlocked, setNetBlocked] = useState(false);
  const [netSource, setNetSource] = useState<string | null>(null);
  const [netLoad, setNetLoad] = useState(true);
  const [netSave, setNetSave] = useState(false);
  const [netErr, setNetErr] = useState<string | null>(null);

  const [prevAgentId, setPrevAgentId] = useState(agentId);

  if (agentId !== prevAgentId) {
    setPrevAgentId(agentId);
    setNetLoad(true);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .agentInternetBlockedGet(agentId)
      .then((r) => {
        if (!cancelled) {
          setNetBlocked(r.blocked);
          setNetSource(r.source ?? null);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setNetLoad(false); });
    return () => { cancelled = true; };
  }, [agentId]);

  const applyNetworkPolicy = (blocked: boolean) => {
    setNetErr(null);
    setNetSave(true);
    api
      .agentInternetBlockedPut(agentId, { blocked })
      .then((r) => { setNetBlocked(r.blocked); setNetSource(r.source ?? null); })
      .catch((e) => setNetErr(String(e)))
      .finally(() => setNetSave(false));
  };

  const sourceLabel = (src: string | null) => {
    if (src === "all") return "all devices rule";
    if (src === "group") return "group rule";
    return null;
  };

  // ── App blocking ─────────────────────────────────────────────────────────────
  const [rules, setRules] = useState<AppBlockRule[]>([]);
  const [rulesLoad, setRulesLoad] = useState(true);
  const [rulesErr, setRulesErr] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [deletingRule, setDeletingRule] = useState<AppBlockRule | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const loadRules = useCallback(() => {
    setRulesLoad(true);
    setRulesErr(null);
    api
      .appBlockRulesList(agentId)
      .then((r) => setRules(r.rules))
      .catch((e) => setRulesErr(String(e)))
      .finally(() => setRulesLoad(false));
  }, [agentId]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const toggleRule = (rule: AppBlockRule) => {
    setTogglingId(rule.id);
    api
      .appBlockRulesUpdate(rule.id, { enabled: !rule.enabled })
      .then(() => setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r)))
      .catch((e) => setRulesErr(String(e)))
      .finally(() => setTogglingId(null));
  };

  const deleteRule = (rule: AppBlockRule) => {
    setDeletingId(rule.id);
    api
      .appBlockRulesDelete(rule.id)
      .then(() => setRules((prev) => prev.filter((r) => r.id !== rule.id)))
      .catch((e) => setRulesErr(String(e)))
      .finally(() => {
        setDeletingId(null);
        setDeletingRule(null);
      });
  };

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
        onCreated={loadRules}
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
