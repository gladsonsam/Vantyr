import { AgentReplacementSettings } from "./AgentReplacementSettings";
import { AgentModuleSettings } from "./AgentModuleSettings";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { AgentGroup, AgentGroupMembership, DashboardRole, RetentionPolicy } from "@/api/types";
import { SecuritySettings } from "@/features/settings/SecuritySettings";
import { AgentRecallSettings } from "@/features/recall/components/AgentRecallSettings";
import { api } from "@/api";
import { useServerVersionPayload } from "@/api/serverVersionStore";
import { AGENT_ICON_DEFS, AGENT_ICON_MAP, type AgentIconKey, isAgentIconKey } from "@/lib/agentIcons";
import {
  daysToField,
  fieldToDays,
  fmtRetentionBrief,
  parseRetentionField,
} from "@/lib/retentionForm";
import { Switch } from "@/components/common/SettingsSwitch";

interface Props {
  agentId: string;
  agentName: string;
  agentOnline: boolean;
  agentVersion: string | null;
  isAdmin?: boolean;
  dashboardRole?: DashboardRole | null;
  onOpenAgentGroups?: () => void;
}

function RetentionOverrideField({
  title,
  value,
  onChange,
  globalDays,
  parsed,
  formDisabled,
}: {
  title: string;
  value: string;
  onChange: (v: string) => void;
  globalDays: number | null | undefined;
  parsed: { value: number | null; error: string | null };
  formDisabled: boolean;
}) {
  return (
    <Field>
      <FieldLabel>{title}</FieldLabel>
      <Input
        inputMode="numeric"
        value={value}
        disabled={formDisabled}
        aria-invalid={Boolean(parsed.error)}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Blank = inherit, 0 = unlimited"
        className="h-9"
      />
      {parsed.error ? (
        <FieldError>{parsed.error}</FieldError>
      ) : (
        <p className="text-xs text-muted-foreground">
          Default: {fmtRetentionBrief(globalDays)} · Effective: {fmtRetentionBrief(parsed.value)}
        </p>
      )}
    </Field>
  );
}

function KeyValues({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg bg-muted/50 px-3.5 py-3">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 font-mono text-[13px]">{item.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Per-computer settings and on-device security guidance (Settings tab on an agent).
 */
export function AgentSettingsTab({
  agentId,
  agentName,
  agentOnline,
  agentVersion,
  isAdmin = false,
  dashboardRole = null,
  onOpenAgentGroups,
}: Props) {
  // Backend: icon PUT = operator+; retention / auto-update /
  // update-now overrides = admin-only.
  const canOperate = dashboardRole !== "viewer";
  const [agentIcon, setAgentIcon] = useState<AgentIconKey>("monitor");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconLoad, setIconLoad] = useState(true);
  const [iconSave, setIconSave] = useState(false);
  const [iconErr, setIconErr] = useState<string | null>(null);
  const [iconOk, setIconOk] = useState<string | null>(null);
  const [agKey, setAgKey] = useState("");
  const [agWin, setAgWin] = useState("");
  const [agUrl, setAgUrl] = useState("");
  const [agGlobal, setAgGlobal] = useState<RetentionPolicy | null>(null);
  const [load, setLoad] = useState(true);
  const [save, setSave] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [autoUpdLoad, setAutoUpdLoad] = useState(true);
  const [autoUpdSave, setAutoUpdSave] = useState(false);
  const [autoUpdErr, setAutoUpdErr] = useState<string | null>(null);
  const [autoUpdOk, setAutoUpdOk] = useState<string | null>(null);
  const [autoUpdGlobal, setAutoUpdGlobal] = useState<boolean | null>(null);
  const [autoUpdOverride, setAutoUpdOverride] = useState<{ enabled: boolean } | null>(null);
  const versionPayload = useServerVersionPayload();
  const latestAgentVersion = versionPayload?.latest_agent_version ?? null;
  const [updNow, setUpdNow] = useState(false);
  const [updNowErr, setUpdNowErr] = useState<string | null>(null);
  const [updNowOk, setUpdNowOk] = useState<string | null>(null);

  const [memberGroups, setMemberGroups] = useState<AgentGroupMembership[] | null>(null);
  const [allGroupsPick, setAllGroupsPick] = useState<AgentGroup[]>([]);
  const [grpLoad, setGrpLoad] = useState(false);
  const [grpErr, setGrpErr] = useState<string | null>(null);
  const [grpOk, setGrpOk] = useState<string | null>(null);
  const [addGroupPick, setAddGroupPick] = useState<string>("");
  const [grpBusy, setGrpBusy] = useState(false);

  // Version freshness is handled by `GeneralConfig` in the agent header.

  const refreshAgentGroups = useCallback(() => {
    if (!isAdmin) return;
    setGrpErr(null);
    setGrpLoad(true);
    Promise.all([api.agentGroupsForAgent(agentId), api.agentGroupsList()])
      .then(([mem, all]) => {
        setMemberGroups(mem.groups);
        setAllGroupsPick(all.groups);
      })
      .catch((e) => {
        setMemberGroups(null);
        setGrpErr(String(e));
      })
      .finally(() => setGrpLoad(false));
  }, [agentId, isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      setMemberGroups(null);
      setAllGroupsPick([]);
      return;
    }
    refreshAgentGroups();
  }, [isAdmin, refreshAgentGroups]);

  const addableGroupOptions = useMemo(() => {
    const inSet = new Set((memberGroups ?? []).map((g) => g.id));
    return [...allGroupsPick]
      .filter((g) => !inSet.has(g.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ label: g.name, value: g.id }));
  }, [allGroupsPick, memberGroups]);

  const addAgentToSelectedGroup = () => {
    if (!addGroupPick) return;
    setGrpErr(null);
    setGrpOk(null);
    setGrpBusy(true);
    api
      .agentGroupMembersAdd(addGroupPick, { agent_ids: [agentId] })
      .then(() => {
        setGrpOk("Added to group.");
        setAddGroupPick("");
        refreshAgentGroups();
      })
      .catch((e) => setGrpErr(String(e)))
      .finally(() => setGrpBusy(false));
  };

  const removeAgentFromGroup = (groupId: string) => {
    setGrpErr(null);
    setGrpOk(null);
    setGrpBusy(true);
    api
      .agentGroupMemberRemove(groupId, agentId)
      .then(() => {
        setGrpOk("Removed from group.");
        refreshAgentGroups();
      })
      .catch((e) => setGrpErr(String(e)))
      .finally(() => setGrpBusy(false));
  };

  const parsedKey = useMemo(() => parseRetentionField(agKey, "agent"), [agKey]);
  const parsedWin = useMemo(() => parseRetentionField(agWin, "agent"), [agWin]);
  const parsedUrl = useMemo(() => parseRetentionField(agUrl, "agent"), [agUrl]);
  const hasRetentionErrors =
    !!parsedKey.error || !!parsedWin.error || !!parsedUrl.error;

  // Overrides: blank = inherit, 0 = unlimited.

  const [prevSettingsAgentId, setPrevSettingsAgentId] = useState(agentId);

  if (agentId !== prevSettingsAgentId) {
    setPrevSettingsAgentId(agentId);
    setLoad(true);
    setErr(null);
    setOk(null);
    setIconErr(null);
    setIconOk(null);
    setIconLoad(true);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.retentionAgentGet(agentId),
      api.agentIconGet(agentId),
      api.agentAutoUpdateAgentGet(agentId),
    ])
      .then(([{ global, override }, icon, autoUpd]) => {
        if (cancelled) return;
        setAgGlobal(global);
        const o = override ?? {
          keylog_days: null,
          window_days: null,
          url_days: null,
        };
        setAgKey(daysToField(o.keylog_days, "agent"));
        setAgWin(daysToField(o.window_days, "agent"));
        setAgUrl(daysToField(o.url_days, "agent"));
        setAgentIcon(isAgentIconKey(icon.icon) ? icon.icon : "monitor");
        setAutoUpdGlobal(autoUpd.global.enabled);
        setAutoUpdOverride(autoUpd.override);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) {
          setLoad(false);
          setIconLoad(false);
          setAutoUpdLoad(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const saveAgentIcon = (next: AgentIconKey) => {
    if (!canOperate) return;
    setIconErr(null);
    setIconOk(null);
    setIconSave(true);
    api
      .agentIconPut(agentId, next)
      .then((r) => {
        setAgentIcon(isAgentIconKey(r.icon) ? r.icon : "monitor");
        setIconOk("Saved.");
      })
      .catch((e) => setIconErr(String(e)))
      .finally(() => setIconSave(false));
  };

  const saveOverrides = () => {
    if (!isAdmin) return;
    setErr(null);
    setOk(null);
    let body: RetentionPolicy;
    try {
      body = {
        keylog_days: fieldToDays(agKey, "agent"),
        window_days: fieldToDays(agWin, "agent"),
        url_days: fieldToDays(agUrl, "agent"),
      };
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    setSave(true);
    api
      .retentionAgentPut(agentId, body)
      .then(({ global, override }) => {
        setAgGlobal(global);
        const o = override ?? {
          keylog_days: null,
          window_days: null,
          url_days: null,
        };
        setAgKey(daysToField(o.keylog_days, "agent"));
        setAgWin(daysToField(o.window_days, "agent"));
        setAgUrl(daysToField(o.url_days, "agent"));
        setOk("Saved.");
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setSave(false));
  };

  const clearOverrides = () => {
    if (!isAdmin) return;
    setErr(null);
    setOk(null);
    setSave(true);
    api
      .retentionAgentDelete(agentId)
      .then(({ global, override }) => {
        setAgGlobal(global);
        const o = override ?? {
          keylog_days: null,
          window_days: null,
          url_days: null,
        };
        setAgKey(daysToField(o.keylog_days, "agent"));
        setAgWin(daysToField(o.window_days, "agent"));
        setAgUrl(daysToField(o.url_days, "agent"));
        setOk("Using defaults.");
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setSave(false));
  };

  const saveAutoUpdateOverride = (enabled: boolean) => {
    if (!isAdmin) return;
    setAutoUpdErr(null);
    setAutoUpdOk(null);
    setAutoUpdSave(true);
    api
      .agentAutoUpdateAgentPut(agentId, { enabled })
      .then((s) => {
        setAutoUpdGlobal(s.global.enabled);
        setAutoUpdOverride(s.override);
        setAutoUpdOk(
          s.override
            ? "Saved. Applies when the agent connects."
            : "Saved.",
        );
      })
      .catch((e) => setAutoUpdErr(String(e)))
      .finally(() => setAutoUpdSave(false));
  };

  const clearAutoUpdateOverride = () => {
    if (!isAdmin) return;
    setAutoUpdErr(null);
    setAutoUpdOk(null);
    setAutoUpdSave(true);
    api
      .agentAutoUpdateAgentDelete(agentId)
      .then((s) => {
        setAutoUpdGlobal(s.global.enabled);
        setAutoUpdOverride(s.override);
        setAutoUpdOk("Using global default.");
      })
      .catch((e) => setAutoUpdErr(String(e)))
      .finally(() => setAutoUpdSave(false));
  };


  const isOutOfDate =
    !!latestAgentVersion &&
    !!agentVersion &&
    latestAgentVersion.trim().replace(/^v/i, "") !== agentVersion.trim().replace(/^v/i, "");

  const triggerUpdateNow = () => {
    if (!isAdmin) return;
    setUpdNowErr(null);
    setUpdNowOk(null);
    setUpdNow(true);
    api
      .agentUpdateNow(agentId)
      .then(() => {
        setUpdNowOk("Update triggered.");
      })
      .catch((e) => setUpdNowErr(String(e)))
      .finally(() => setUpdNow(false));
  };

  const effectiveItems = agGlobal
    ? [
        {
          label: "Keylogs",
          value: agKey.trim()
            ? parsedKey.error
              ? "Invalid"
              : fmtRetentionBrief(parsedKey.value)
            : fmtRetentionBrief(agGlobal.keylog_days),
        },
        {
          label: "Windows",
          value: agWin.trim()
            ? parsedWin.error
              ? "Invalid"
              : fmtRetentionBrief(parsedWin.value)
            : fmtRetentionBrief(agGlobal.window_days),
        },
        {
          label: "URLs",
          value: agUrl.trim()
            ? parsedUrl.error
              ? "Invalid"
              : fmtRetentionBrief(parsedUrl.value)
            : fmtRetentionBrief(agGlobal.url_days),
        },
      ]
    : [];

  const tabs = [
    ...(canOperate ? [{ id: "modules", label: "Modules" }] : []),
    { id: "general", label: "General" },
    ...(isAdmin ? [{ id: "groups", label: "Groups" }] : []),
    { id: "retention", label: "Retention" },
    { id: "recall", label: "Recall" },
    { id: "security", label: "Security" },
    { id: "updates", label: "Updates" },
  ];

  const IconPreview = agentIcon ? AGENT_ICON_MAP[agentIcon].Icon : null;

  return (
    <Tabs defaultValue={tabs[0]?.id}>
      <TabsList aria-label="Agent settings sections">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {canOperate && (
        <TabsContent value="modules">
          <AgentModuleSettings agentId={agentId} canOperate={canOperate} />
        </TabsContent>
      )}

      <TabsContent value="general">
        <div className="flex flex-col gap-6">
          {isAdmin && <AgentReplacementSettings key={agentId} agentId={agentId} agentName={agentName} />}
          <Card className="gap-0 py-0">
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle>Agent icon</CardTitle>
              <CardDescription>Shown on the Agents overview.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-5 pb-5">
              {iconErr && (
                <Alert variant="destructive">
                  <AlertDescription>{iconErr}</AlertDescription>
                </Alert>
              )}
              {iconOk && (
                <Alert>
                  <AlertDescription className="text-success">{iconOk}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel>Icon</FieldLabel>
                <button
                  type="button"
                  disabled={iconLoad || iconSave || !canOperate}
                  onClick={() => setIconPickerOpen(true)}
                  aria-label="Change agent icon"
                  className="flex size-14 items-center justify-center rounded-xl bg-muted/70 text-foreground outline-none transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {IconPreview && <IconPreview size={28} />}
                </button>
                {!canOperate && <FieldDescription>Operators only.</FieldDescription>}
              </Field>
            </CardContent>
          </Card>

          <Dialog open={iconPickerOpen} onOpenChange={setIconPickerOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Pick an icon</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-6 gap-1.5" role="group" aria-label="Agent icons">
                {AGENT_ICON_DEFS.map(({ key }) => {
                  const Icon = AGENT_ICON_MAP[key].Icon;
                  const selected = agentIcon === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setAgentIcon(key);
                        setIconPickerOpen(false);
                        saveAgentIcon(key);
                      }}
                      aria-label={key}
                      aria-pressed={selected}
                      className={cn(
                        "flex size-11 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "bg-primary/15 text-primary ring-2 ring-primary",
                      )}
                    >
                      <Icon size={22} />
                    </button>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </TabsContent>

      {isAdmin && (
        <TabsContent value="groups">
          <Card className="gap-0 py-0">
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle>Agent groups</CardTitle>
              <CardDescription>Inherits alert rules from these groups.</CardDescription>
              {onOpenAgentGroups && (
                <CardAction>
                  <Button variant="outline" size="sm" disabled={grpBusy} onClick={() => onOpenAgentGroups()}>
                    Manage groups
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-5 pb-5">
              {grpErr && (
                <Alert variant="destructive">
                  <AlertDescription>{grpErr}</AlertDescription>
                </Alert>
              )}
              {grpOk && (
                <Alert>
                  <AlertDescription className="text-success">{grpOk}</AlertDescription>
                </Alert>
              )}
              {grpLoad && memberGroups === null ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Spinner /> Loading groups…
                </div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="px-3">Group</TableHead>
                        <TableHead className="px-3">Description</TableHead>
                        <TableHead className="w-25 px-3"><span className="sr-only">Remove</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(memberGroups ?? []).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="px-3 py-8 text-center text-sm text-muted-foreground">
                            Not in any group.
                          </TableCell>
                        </TableRow>
                      ) : (
                        (memberGroups ?? []).map((g) => (
                          <TableRow key={g.id}>
                            <TableCell className="px-3 py-3.5 font-medium">{g.name}</TableCell>
                            <TableCell className="px-3 py-3.5">{g.description?.trim() || "—"}</TableCell>
                            <TableCell className="px-3 py-3.5">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={grpBusy}
                                onClick={() => removeAgentFromGroup(g.id)}
                              >
                                Remove
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  <Field>
                    <FieldLabel htmlFor="add-to-group">Add to group</FieldLabel>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Select
                        value={addGroupPick}
                        onValueChange={(value) => setAddGroupPick(value ?? "")}
                        disabled={grpBusy || addableGroupOptions.length === 0}
                      >
                        <SelectTrigger id="add-to-group" className="h-9 w-full sm:max-w-xs">
                          <SelectValue placeholder="Choose a group" />
                        </SelectTrigger>
                        <SelectContent>
                          {addableGroupOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        disabled={!addGroupPick || grpBusy}
                        onClick={() => addAgentToSelectedGroup()}
                      >
                        Add
                      </Button>
                    </div>
                    {addableGroupOptions.length === 0 && (
                      <FieldDescription>No other groups.</FieldDescription>
                    )}
                  </Field>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      )}

      <TabsContent value="retention">
        <Card className="gap-0 py-0">
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle>Retention overrides</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {load ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner /> Loading retention…
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                {!isAdmin && (
                  <Alert>
                    <AlertDescription>Admin only.</AlertDescription>
                  </Alert>
                )}
                {err && (
                  <Alert variant="destructive">
                    <AlertDescription>{err}</AlertDescription>
                  </Alert>
                )}
                {ok && (
                  <Alert>
                    <AlertDescription className="text-success">{ok}</AlertDescription>
                  </Alert>
                )}

                {agGlobal ? (
                  <KeyValues
                    items={[
                      { label: "Default keylogs", value: fmtRetentionBrief(agGlobal.keylog_days) },
                      { label: "Default windows", value: fmtRetentionBrief(agGlobal.window_days) },
                      { label: "Default URLs", value: fmtRetentionBrief(agGlobal.url_days) },
                      ...effectiveItems,
                    ]}
                  />
                ) : null}

                <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                  <RetentionOverrideField
                    title="Keylogs"
                    value={agKey}
                    onChange={setAgKey}
                    globalDays={agGlobal?.keylog_days}
                    parsed={parsedKey}
                    formDisabled={save || !isAdmin}
                  />
                  <RetentionOverrideField
                    title="Windows"
                    value={agWin}
                    onChange={setAgWin}
                    globalDays={agGlobal?.window_days}
                    parsed={parsedWin}
                    formDisabled={save || !isAdmin}
                  />
                  <RetentionOverrideField
                    title="URLs"
                    value={agUrl}
                    onChange={setAgUrl}
                    globalDays={agGlobal?.url_days}
                    parsed={parsedUrl}
                    formDisabled={save || !isAdmin}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={save || hasRetentionErrors || !isAdmin}
                    onClick={saveOverrides}
                  >
                    {save && <Spinner />} Save
                  </Button>
                  <Button variant="outline" disabled={save || !isAdmin} onClick={clearOverrides}>
                    Clear overrides
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="recall">
        <AgentRecallSettings agentId={agentId} isAdmin={isAdmin} />
      </TabsContent>

      <TabsContent value="security">
        <SecuritySettings />
      </TabsContent>

      <TabsContent value="updates">
        <div className="flex flex-col gap-6">
          {!load && (
            <Card className="gap-0 py-0">
              <CardHeader className="px-5 pt-5 pb-2">
                <CardTitle>Update agent</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-5 px-5 pb-5">
                <dl className="grid grid-cols-1 gap-4">
                  {[
                    { label: "Installed", value: agentVersion ?? "—" },
                    { label: "Latest", value: latestAgentVersion ?? "—" },
                    { label: "Status", value: isOutOfDate ? "Out of date" : "Up to date (or unknown)" },
                  ].map((item) => (
                    <div key={item.label} className="rounded-lg bg-muted/50 px-3.5 py-3">
                      <dt className="text-xs text-muted-foreground">{item.label}</dt>
                      <dd className="mt-1 font-mono text-[13px]">{item.value}</dd>
                    </div>
                  ))}
                </dl>

                {updNowErr && (
                  <Alert variant="destructive">
                    <AlertDescription>{updNowErr}</AlertDescription>
                  </Alert>
                )}
                {updNowOk && (
                  <Alert>
                    <AlertDescription className="text-success">{updNowOk}</AlertDescription>
                  </Alert>
                )}

                {agentOnline ? (
                  <div>
                    <Button
                      variant={isOutOfDate ? "default" : "outline"}
                      disabled={updNow || !isAdmin}
                      onClick={triggerUpdateNow}
                    >
                      {updNow && <Spinner />} Update now
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Agent offline.
                  </p>
                )}
                {!isAdmin && (
                  <p className="text-sm text-muted-foreground">
                    Admin only.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {!load && (
            <Card className="gap-0 py-0">
              <CardHeader className="px-5 pt-5 pb-2">
                <CardTitle>Auto updates</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-5 px-5 pb-5">
                <dl className="grid grid-cols-1 gap-4">
                  <div className="rounded-lg bg-muted/50 px-3.5 py-3">
                    <dt className="text-xs text-muted-foreground">Global default</dt>
                    <dd className="mt-1 font-mono text-[13px]">
                      {autoUpdGlobal == null ? "—" : autoUpdGlobal ? "Enabled" : "Disabled"}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-muted/50 px-3.5 py-3">
                    <dt className="text-xs text-muted-foreground">This computer</dt>
                    <dd className="mt-1 font-mono text-[13px]">
                      {autoUpdOverride === null
                        ? "Inherited"
                        : autoUpdOverride.enabled
                          ? "Enabled"
                          : "Disabled"}
                    </dd>
                  </div>
                </dl>

                {autoUpdErr && (
                  <Alert variant="destructive">
                    <AlertDescription>{autoUpdErr}</AlertDescription>
                  </Alert>
                )}
                {autoUpdOk && (
                  <Alert>
                    <AlertDescription className="text-success">{autoUpdOk}</AlertDescription>
                  </Alert>
                )}

                <Field>
                  <FieldLabel htmlFor="agent-auto-update">Override</FieldLabel>
                  <div className="flex items-center gap-3">
                    <Switch
                      id="agent-auto-update"
                      checked={autoUpdOverride?.enabled ?? autoUpdGlobal ?? true}
                      disabled={autoUpdLoad || autoUpdSave || !isAdmin}
                      onCheckedChange={(checked) => saveAutoUpdateOverride(checked)}
                    />
                    <span className="text-sm">Auto updates</span>
                    {autoUpdSave && <Spinner />}
                  </div>
                  {!isAdmin && <FieldDescription>Admin only.</FieldDescription>}
                </Field>

                {autoUpdOverride !== null ? (
                  <div>
                    <Button variant="outline" disabled={autoUpdSave || !isAdmin} onClick={clearAutoUpdateOverride}>
                      Use global default
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
