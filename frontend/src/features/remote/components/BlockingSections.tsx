import { Ban, Globe, GlobeLock, Plus, Trash2 } from "lucide-react";
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
import { Spinner } from "@vantyr/ui/components/spinner";
import { Link as RouterLink } from "react-router-dom";
import type { AgentInfo, AppBlockRule } from "@/api/types";
import { AppIcon } from "@/components/common/AppIcon";
import { HelpTip } from "@/components/common/HelpTip";
import { Switch } from "@/components/common/SettingsSwitch";
import {
  capabilityNeedsCaution,
  capabilityStatus,
} from "@/features/agent-detail/lib/agentCapabilities";
import {
  blockSourceLabel,
  capabilityPhrase,
  deleteConsequence,
  matchModeLabel,
  resolvedScopeKind,
  rulesSummary,
  scopeLabel,
} from "@/features/remote/lib/blocking";
import { cn } from "@/lib/utils";

const SECTION = "overflow-hidden rounded-xl bg-card";
const ROW_PADDING = "px-4 sm:px-5";

function Problem({ children, retry }: { children: string; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <span className="min-w-0 break-words">{children}</span>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

interface InternetProps {
  loading: boolean;
  loadFailed: boolean;
  blocked: boolean;
  source: string | null;
  saving: boolean;
  available: boolean;
  online: boolean;
  info?: AgentInfo | null;
  error: string | null;
  onReload: () => void;
  onAllow: () => void;
  onAskBlock: () => void;
}

/** What the internet policy is right now, and the one action that changes it. */
export function InternetSection({
  loading,
  loadFailed,
  blocked,
  source,
  saving,
  available,
  online,
  info,
  error,
  onReload,
  onAllow,
  onAskBlock,
}: InternetProps) {
  const inherited = blocked ? blockSourceLabel(source) : null;
  const known = !loading && !loadFailed;
  return (
    <section className={cn(SECTION, "flex flex-col gap-3 p-4 sm:p-5")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <InternetIcon known={known} blocked={blocked} />
          <div className="min-w-0">
            <h2 className="flex items-center gap-1 text-sm font-medium" aria-live="polite">
              {internetTitle({ loading, loadFailed, blocked })}
              <HelpTip label="About internet blocking">
                Blocks everything except Vantyr itself, so you can still manage the device. Rules
                for groups or the whole fleet are on the{" "}
                <RouterLink
                  to="/rules?tab=internet-access"
                  className="text-primary hover:underline"
                >
                  Rules
                </RouterLink>{" "}
                page.
              </HelpTip>
            </h2>
            {inherited && (
              <p className="text-[13px] text-muted-foreground">
                Set by {inherited}. Change it on the{" "}
                <RouterLink
                  to="/rules?tab=internet-access"
                  className="text-primary hover:underline"
                >
                  Rules
                </RouterLink>{" "}
                page.
              </p>
            )}
          </div>
        </div>
        <InternetAction
          known={known}
          failed={loadFailed}
          blocked={blocked}
          inherited={inherited !== null}
          saving={saving}
          available={available}
          onReload={onReload}
          onAllow={onAllow}
          onAskBlock={onAskBlock}
        />
      </div>
      <InternetNotes available={available} online={online} info={info} />
      {error && <Problem>{error}</Problem>}
    </section>
  );
}

function internetTitle({
  loading,
  loadFailed,
  blocked,
}: {
  loading: boolean;
  loadFailed: boolean;
  blocked: boolean;
}): string {
  if (loadFailed) return "Internet status unknown";
  if (loading) return "Checking internet…";
  return blocked ? "Internet is blocked" : "Internet is allowed";
}

/** Block / Allow when this device's own policy can be changed here; Try again when the status didn't load; nothing when a rule elsewhere decides. */
function InternetAction({
  known,
  failed,
  blocked,
  inherited,
  saving,
  available,
  onReload,
  onAllow,
  onAskBlock,
}: {
  known: boolean;
  failed: boolean;
  blocked: boolean;
  inherited: boolean;
  saving: boolean;
  available: boolean;
  onReload: () => void;
  onAllow: () => void;
  onAskBlock: () => void;
}) {
  if (failed)
    return (
      <Button variant="outline" size="sm" onClick={onReload}>
        Try again
      </Button>
    );
  if (!known || inherited) return null;
  return (
    <Button
      variant={blocked ? "outline" : "destructive"}
      disabled={!available || saving}
      onClick={blocked ? onAllow : onAskBlock}
    >
      {saving && <Spinner />}
      {blocked ? (saving ? "Allowing…" : "Allow internet") : "Block internet"}
    </Button>
  );
}

function InternetIcon({ known, blocked }: { known: boolean; blocked: boolean }) {
  const Icon = blocked ? GlobeLock : Globe;
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg",
        !known
          ? "bg-muted text-muted-foreground"
          : blocked
            ? "bg-warning/15 text-warning"
            : "bg-success/15 text-success",
      )}
      aria-hidden="true"
    >
      <Icon className="size-4.5" />
    </span>
  );
}

function InternetNotes({
  available,
  online,
  info,
}: {
  available: boolean;
  online: boolean;
  info?: AgentInfo | null;
}) {
  const status = capabilityStatus(info, "network_blocking");
  const notes = [
    !available && `Not available on this device (${capabilityPhrase(status)}).`,
    available &&
      capabilityNeedsCaution(info, "network_blocking") &&
      `The device may need administrator rights to do this (${capabilityPhrase(status)}).`,
    !online && "Device offline. Changes apply when it reconnects.",
  ].filter((n): n is string => typeof n === "string");
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-[13px] text-muted-foreground">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

export function BlockInternetDialog({
  open,
  agentName,
  online,
  saving,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  agentName: string;
  online: boolean;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Block internet on {agentName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Everything on the device loses internet access, except its connection to Vantyr.{" "}
            {online
              ? "This takes effect right away."
              : "The device is offline, so it applies when it reconnects."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={saving} onClick={onConfirm}>
            {saving && <Spinner />} Block internet
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface RulesProps {
  agentId: string;
  loading: boolean;
  rules: AppBlockRule[];
  available: boolean;
  info?: AgentInfo | null;
  error: string | null;
  togglingId: number | null;
  deletingId: number | null;
  onReload: () => void;
  onAdd: () => void;
  onToggle: (rule: AppBlockRule) => void;
  onAskDelete: (rule: AppBlockRule) => void;
}

/** Apps that are closed whenever they start on this device, with a switch and a delete per rule. */
export function AppRulesSection({
  agentId,
  loading,
  rules,
  available,
  info,
  error,
  togglingId,
  deletingId,
  onReload,
  onAdd,
  onToggle,
  onAskDelete,
}: RulesProps) {
  const status = capabilityStatus(info, "app_blocking");
  const note = !available
    ? `App blocking isn’t available on this device (${capabilityPhrase(status)}).`
    : capabilityNeedsCaution(info, "app_blocking")
      ? `App blocking is limited on this device (${capabilityPhrase(status)}).`
      : null;
  return (
    <section className={SECTION}>
      <div className={cn("flex items-center gap-3 pt-4 sm:pt-5", ROW_PADDING)}>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">App blocking</h2>
          <p className="text-[13px] text-muted-foreground" role="status">
            {loading && rules.length === 0 ? "Loading…" : rulesSummary(rules)}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!available}
          title={available ? undefined : "App blocking is unavailable on this device"}
          onClick={onAdd}
        >
          <Plus /> Add rule
        </Button>
      </div>
      {note && <p className={cn("pt-3 text-[13px] text-muted-foreground", ROW_PADDING)}>{note}</p>}
      {error && (
        <div className={cn("pt-3", ROW_PADDING)}>
          <Problem retry={onReload}>{error}</Problem>
        </div>
      )}
      {rules.length > 0 ? (
        <ul className="mt-3 divide-y divide-foreground/[0.06] border-t border-foreground/[0.06]">
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              agentId={agentId}
              rule={r}
              disabled={!available || togglingId === r.id}
              deleting={deletingId === r.id}
              onToggle={onToggle}
              onAskDelete={onAskDelete}
            />
          ))}
        </ul>
      ) : (
        <div
          className={cn("flex items-center gap-2 py-8 text-sm text-muted-foreground", ROW_PADDING)}
        >
          {loading ? <Spinner /> : <Ban className="size-4" aria-hidden="true" />}
          {loading ? "Loading rules…" : "No apps are blocked on this device."}
        </div>
      )}
    </section>
  );
}

function RuleRow({
  agentId,
  rule,
  disabled,
  deleting,
  onToggle,
  onAskDelete,
}: {
  agentId: string;
  rule: AppBlockRule;
  disabled: boolean;
  deleting: boolean;
  onToggle: (rule: AppBlockRule) => void;
  onAskDelete: (rule: AppBlockRule) => void;
}) {
  const kind = resolvedScopeKind(rule);
  const shared = kind !== "agent";
  const detail = [
    rule.name && rule.name !== rule.exe_pattern ? rule.name : null,
    matchModeLabel(rule.match_mode),
    scopeLabel(kind),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className={cn("flex items-center gap-3 py-3", ROW_PADDING)}>
      <AppIcon agentId={agentId} exeName={rule.exe_pattern} size={20} />
      <div className={cn("min-w-0 flex-1", !rule.enabled && "opacity-60")}>
        <p className="font-sans text-[13px] break-all">{rule.exe_pattern}</p>
        <p className="text-xs break-words text-muted-foreground">{detail}</p>
      </div>
      <Switch
        className="after:absolute after:-inset-y-3 after:-inset-x-1 after:content-[''] pointer-fine:after:hidden"
        checked={rule.enabled}
        disabled={disabled}
        onCheckedChange={() => onToggle(rule)}
        aria-label={`${rule.exe_pattern}${shared ? ` (${scopeLabel(kind).toLowerCase()})` : ""}: block this app`}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-destructive max-sm:size-9 pointer-coarse:size-9"
        aria-label={`Delete rule for ${rule.exe_pattern}`}
        title="Delete rule"
        disabled={deleting}
        onClick={() => onAskDelete(rule)}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

export function DeleteRuleDialog({
  rule,
  deleting,
  onCancel,
  onConfirm,
}: {
  rule: AppBlockRule | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: (rule: AppBlockRule) => void;
}) {
  return (
    <AlertDialog
      open={rule !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete block rule?</AlertDialogTitle>
          <AlertDialogDescription>{rule ? deleteConsequence(rule) : null}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              if (rule) onConfirm(rule);
            }}
          >
            {deleting && <Spinner />} Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
