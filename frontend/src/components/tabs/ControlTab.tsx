import { useState, useEffect, useCallback } from "react";
import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import Toggle from "@cloudscape-design/components/toggle";
import { api } from "../../lib/api";
import type { AppBlockRule } from "../../lib/types";
import { AppIcon } from "../common/AppIcon";
import { AppBlockModal } from "./AppBlockModal";

interface ControlTabProps {
  agentId: string;
  agentName: string;
  agentOnline: boolean;
  isAdmin: boolean;
}

export function ControlTab({ agentId, agentName, agentOnline, isAdmin }: ControlTabProps) {
  // ── Internet access ──────────────────────────────────────────────────────────
  const [netBlocked, setNetBlocked] = useState(false);
  const [netSource, setNetSource] = useState<string | null>(null);
  const [netLoad, setNetLoad] = useState(true);
  const [netSave, setNetSave] = useState(false);
  const [netErr, setNetErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNetLoad(true);
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
    if (!confirm(`Delete block rule "${rule.name || rule.exe_pattern}"?`)) return;
    setDeletingId(rule.id);
    api
      .appBlockRulesDelete(rule.id)
      .then(() => setRules((prev) => prev.filter((r) => r.id !== rule.id)))
      .catch((e) => setRulesErr(String(e)))
      .finally(() => setDeletingId(null));
  };

  const resolvedScopeKind = (rule: AppBlockRule) =>
    rule.scope_kind ?? rule.scopes?.[0]?.kind ?? "agent";

  const scopeLabel = (rule: AppBlockRule) => {
    const kind = resolvedScopeKind(rule);
    if (kind === "all") return "All devices";
    if (kind === "group") return "Group";
    return "This device";
  };

  const enabledRuleCount = rules.reduce((acc, r) => acc + (r.enabled ? 1 : 0), 0);

  if (!isAdmin) {
    return (
      <div className="sentinel-control-tab">
        <Alert type="info" header="Admin access required">
          Managing device controls requires administrator access.
        </Alert>
      </div>
    );
  }

  return (
    <div className="sentinel-control-tab">
    <SpaceBetween size="l">
      {/* ── Internet access ─────────────────────────────────────────────────── */}
      <Container
        header={
          <Header
            variant="h2"
            description={
              <Box fontSize="body-s" color="text-body-secondary">
                Managed via <Link href="/rules?tab=internet-access" external={false}>Rules → Internet Access</Link>
              </Box>
            }
            actions={
              !netLoad && (
                <StatusIndicator type={netBlocked ? "warning" : "success"}>
                  {netBlocked ? "Blocked" : "Allowed"}
                </StatusIndicator>
              )
            }
          >
            Internet access
          </Header>
        }
      >
        <SpaceBetween size="s">
          {!agentOnline && (
            <Alert type="warning" statusIconAriaLabel="Warning">
              {agentName} is offline — policy will apply on reconnect.
            </Alert>
          )}
          {netErr && (
            <Alert type="error" dismissible onDismiss={() => setNetErr(null)}>
              {netErr}
            </Alert>
          )}
          {netLoad ? (
            <Box color="text-status-inactive">Loading…</Box>
          ) : (
            <SpaceBetween size="xs">
              <Toggle
                checked={netBlocked}
                disabled={netSave || (netBlocked && netSource !== null && netSource !== "agent")}
                onChange={({ detail }) => applyNetworkPolicy(detail.checked)}
              >
                Block internet
              </Toggle>
              {netBlocked && sourceLabel(netSource) && (
                <Box fontSize="body-s" color="text-body-secondary">
                  Blocked by a {sourceLabel(netSource)} — manage in{" "}
                  <Link href="/rules?tab=internet-access" external={false}>Rules</Link>.
                </Box>
              )}
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Container>

      {/* ── App blocking ────────────────────────────────────────────────────── */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button iconName="add-plus" onClick={() => setShowModal(true)}>
                Add rule
              </Button>
            }
          >
            App blocking
          </Header>
        }
      >
        <SpaceBetween size="s">
          {!rulesLoad ? (
            <Box fontSize="body-s" color="text-body-secondary">
              {enabledRuleCount === 0
                ? "No enabled rules."
                : `${enabledRuleCount} enabled rule${enabledRuleCount === 1 ? "" : "s"}.`}
            </Box>
          ) : null}
          {rulesErr && (
            <Alert type="error" dismissible onDismiss={() => setRulesErr(null)}>
              {rulesErr}
            </Alert>
          )}
          <Table
            loading={rulesLoad}
            loadingText="Loading rules…"
            empty={
              <Box textAlign="center" color="text-body-secondary" padding="l">
                No app block rules for this device.
              </Box>
            }
            items={rules}
            columnDefinitions={[
              {
                id: "pattern",
                header: "EXE name",
                cell: (r) => (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <AppIcon agentId={agentId} exeName={r.exe_pattern} size={18} />
                    <span style={{ fontFamily: "monospace", fontSize: 13 }}>{r.exe_pattern}</span>
                    <Badge color="grey">{r.match_mode}</Badge>
                  </div>
                ),
                width: "45%",
              },
              {
                id: "scope",
                header: "Scope",
                cell: (r) => (
                  <Badge color={resolvedScopeKind(r) === "all" ? "red" : "blue"}>
                    {scopeLabel(r)}
                  </Badge>
                ),
                width: "20%",
              },
              {
                id: "enabled",
                header: "Active",
                cell: (r) => (
                  <Toggle
                    checked={r.enabled}
                    disabled={togglingId === r.id}
                    onChange={() => toggleRule(r)}
                  />
                ),
                width: "15%",
              },
              {
                id: "actions",
                header: "",
                cell: (r) => (
                  <Button
                    variant="inline-icon"
                    iconName="remove"
                    ariaLabel="Delete rule"
                    loading={deletingId === r.id}
                    onClick={() => deleteRule(r)}
                  />
                ),
                width: "10%",
              },
            ]}
          />
        </SpaceBetween>
      </Container>

      <AppBlockModal
        visible={showModal}
        agentId={agentId}
        agentName={agentName}
        onDismiss={() => setShowModal(false)}
        onCreated={loadRules}
      />
    </SpaceBetween>
    </div>
  );
}
