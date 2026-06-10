import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, ColumnLayout, Container, FormField, Header, Input, KeyValuePairs, Modal, SpaceBetween, Select, Tabs, Spinner, Table, Toggle } from "./ui/console";
import type { AgentGroup, AgentGroupMembership, RetentionPolicy } from "../lib/types";
import { api } from "../lib/api";
import { useServerVersionPayload } from "../lib/serverVersionStore";
import { AGENT_ICON_DEFS, AGENT_ICON_MAP, type AgentIconKey, isAgentIconKey } from "../lib/agentIcons";
import {
  daysToField,
  fieldToDays,
  fmtRetentionBrief,
  parseRetentionField,
} from "../lib/retentionForm";

interface Props {
  agentId: string;
  agentName: string;
  agentOnline: boolean;
  agentVersion: string | null;
  isAdmin?: boolean;
  onOpenAgentGroups?: () => void;
}

function RetentionOverrideField({
  title,
  description,
  value,
  onChange,
  globalDays,
  parsed,
  formDisabled,
}: {
  title: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  globalDays: number | null | undefined;
  parsed: { value: number | null; error: string | null };
  formDisabled: boolean;
}) {
  return (
    <FormField
      label={title}
      description={description}
      constraintText={
        parsed.error
          ? undefined
          : `Default: ${fmtRetentionBrief(globalDays)} · Effective: ${fmtRetentionBrief(parsed.value)}`
      }
      errorText={parsed.error || undefined}
    >
      <Input
        inputMode="numeric"
        value={value}
        disabled={formDisabled}
        onChange={({ detail }) => onChange(detail.value)}
        placeholder="Blank = inherit, 0 = unlimited"
      />
    </FormField>
  );
}

/**
 * Per-computer retention and local UI lock overrides (Settings tab on an agent).
 */
export function AgentSettingsTab({
  agentId,
  agentName,
  agentOnline,
  agentVersion,
  isAdmin = false,
  onOpenAgentGroups,
}: Props) {
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
  const [localUiGlobalSet, setLocalUiGlobalSet] = useState(false);
  const [localUiOverride, setLocalUiOverride] = useState<{
    password_set: boolean;
  } | null>(null);
  const [localUiPwd, setLocalUiPwd] = useState("");
  const [localUiPwd2, setLocalUiPwd2] = useState("");
  const [load, setLoad] = useState(true);
  const [save, setSave] = useState(false);
  const [localUiSave, setLocalUiSave] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [localUiErr, setLocalUiErr] = useState<string | null>(null);
  const [localUiOk, setLocalUiOk] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    setLoad(true);
    setErr(null);
    setOk(null);
    setLocalUiErr(null);
    setLocalUiOk(null);
    setIconErr(null);
    setIconOk(null);
    setIconLoad(true);
    Promise.all([
      api.retentionAgentGet(agentId),
      api.localUiPasswordAgentGet(agentId),
      api.agentIconGet(agentId),
      api.agentAutoUpdateAgentGet(agentId),
    ])
      .then(([{ global, override }, localUi, icon, autoUpd]) => {
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
        setLocalUiGlobalSet(localUi.global.password_set);
        setLocalUiOverride(localUi.override);
        setLocalUiPwd("");
        setLocalUiPwd2("");
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
        setOk("This computer now follows the defaults from Preferences.");
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setSave(false));
  };

  const saveLocalUiOverride = () => {
    setLocalUiErr(null);
    setLocalUiOk(null);
    const a = localUiPwd.trim();
    const b = localUiPwd2.trim();
    if (a !== b) {
      setLocalUiErr("Passwords do not match.");
      return;
    }
    if (a.length > 0 && a.length < 4) {
      setLocalUiErr(
        "Use at least 4 characters, or leave both empty for an open window.",
      );
      return;
    }
    setLocalUiSave(true);
    api
      .localUiPasswordAgentPut(agentId, { password: a.length ? a : null })
      .then((s) => {
        setLocalUiGlobalSet(s.global.password_set);
        setLocalUiOverride(s.override);
        setLocalUiPwd("");
        setLocalUiPwd2("");
        setLocalUiOk(
          s.override?.password_set
            ? "Saved. This agent will receive the new lock password when connected."
            : "Saved. This PC’s settings window will stay open (override), unless you set a password above.",
        );
      })
      .catch((e) => setLocalUiErr(String(e)))
      .finally(() => setLocalUiSave(false));
  };

  const clearLocalUiOverride = () => {
    setLocalUiErr(null);
    setLocalUiOk(null);
    setLocalUiSave(true);
    api
      .localUiPasswordAgentDelete(agentId)
      .then((s) => {
        setLocalUiGlobalSet(s.global.password_set);
        setLocalUiOverride(s.override);
        setLocalUiPwd("");
        setLocalUiPwd2("");
        setLocalUiOk("This computer now follows the global default from Preferences.");
      })
      .catch((e) => setLocalUiErr(String(e)))
      .finally(() => setLocalUiSave(false));
  };

  const saveAutoUpdateOverride = (enabled: boolean) => {
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
            ? "Saved. This agent will receive the new auto-update setting when connected."
            : "Saved.",
        );
      })
      .catch((e) => setAutoUpdErr(String(e)))
      .finally(() => setAutoUpdSave(false));
  };

  const clearAutoUpdateOverride = () => {
    setAutoUpdErr(null);
    setAutoUpdOk(null);
    setAutoUpdSave(true);
    api
      .agentAutoUpdateAgentDelete(agentId)
      .then((s) => {
        setAutoUpdGlobal(s.global.enabled);
        setAutoUpdOverride(s.override);
        setAutoUpdOk("This computer now follows the global default from Preferences.");
      })
      .catch((e) => setAutoUpdErr(String(e)))
      .finally(() => setAutoUpdSave(false));
  };


  const isOutOfDate =
    !!latestAgentVersion &&
    !!agentVersion &&
    latestAgentVersion.trim().replace(/^v/i, "") !== agentVersion.trim().replace(/^v/i, "");

  const triggerUpdateNow = () => {
    setUpdNowErr(null);
    setUpdNowOk(null);
    setUpdNow(true);
    api
      .agentUpdateNow(agentId)
      .then(() => {
        setUpdNowOk(
          "Update triggered. If the agent is connected, it will download and install the latest release.",
        );
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
              ? "Invalid input"
              : fmtRetentionBrief(parsedKey.value)
            : fmtRetentionBrief(agGlobal.keylog_days),
        },
        {
          label: "Windows & activity",
          value: agWin.trim()
            ? parsedWin.error
              ? "Invalid input"
              : fmtRetentionBrief(parsedWin.value)
            : fmtRetentionBrief(agGlobal.window_days),
        },
        {
          label: "URLs",
          value: agUrl.trim()
            ? parsedUrl.error
              ? "Invalid input"
              : fmtRetentionBrief(parsedUrl.value)
            : fmtRetentionBrief(agGlobal.url_days),
        },
      ]
    : [];

  return (
    <Tabs
      variant="container"
      tabs={[
        {
          id: "general",
          label: "General",
          content: (
            <SpaceBetween size="l">
              <Container
        header={
          <Header
            variant="h2"
            description={`${agentName} — icon shown on the Agents overview cards.`}
          >
            Agent icon
          </Header>
        }
      >
        <SpaceBetween size="l">
          {iconErr && (
            <Alert type="error" dismissible onDismiss={() => setIconErr(null)}>
              {iconErr}
            </Alert>
          )}
          {iconOk && (
            <Alert type="success" dismissible onDismiss={() => setIconOk(null)}>
              {iconOk}
            </Alert>
          )}

          <FormField
            label="Icon"
            constraintText="Pick an icon for this computer."
          >
            <SpaceBetween direction="horizontal" size="s" alignItems="center">
              <button
                type="button"
                className="vantyr-agent-icon-lg vantyr-agent-icon-lg-clickable"
                disabled={iconLoad || iconSave}
                onClick={() => setIconPickerOpen(true)}
                aria-label="Change agent icon"
              >
                {agentIcon
                  ? (() => {
                      const Icon = AGENT_ICON_MAP[agentIcon].Icon;
                      return <Icon size={28} />;
                    })()
                  : null}
              </button>
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Container>

      <Modal
        visible={iconPickerOpen}
        onDismiss={() => setIconPickerOpen(false)}
        header="Pick an icon"
      >
        <div className="vantyr-icon-picker-grid">
          {AGENT_ICON_DEFS.map(({ key }) => {
            const Icon = AGENT_ICON_MAP[key].Icon;
            const selected = agentIcon === key;
            return (
              <button
                key={key}
                type="button"
                className={
                  "vantyr-icon-picker-item" + (selected ? " is-selected" : "")
                }
                onClick={() => {
                  setAgentIcon(key);
                  setIconPickerOpen(false);
                  saveAgentIcon(key);
                }}
                aria-label={key}
                aria-pressed={selected}
              >
                <Icon size={22} />
              </button>
            );
          })}
        </div>
      </Modal>
            </SpaceBetween>
          )
        },
        ...(isAdmin ? [{
          id: "groups",
          label: "Groups",
          content: (
            <SpaceBetween size="l">
              {isAdmin && (
        <Container
          header={
            <Header
              variant="h2"
              description={`Alert rules can target all agents, specific groups, or one computer. ${agentName} inherits rules for each group below.`}
              actions={
                onOpenAgentGroups ? (
                  <Button onClick={() => onOpenAgentGroups()} disabled={grpBusy}>
                    All groups & alert rules
                  </Button>
                ) : undefined
              }
            >
              Agent groups
            </Header>
          }
        >
          <SpaceBetween size="m">
            {grpErr && (
              <Alert type="error" dismissible onDismiss={() => setGrpErr(null)}>
                {grpErr}
              </Alert>
            )}
            {grpOk && (
              <Alert type="success" dismissible onDismiss={() => setGrpOk(null)}>
                {grpOk}
              </Alert>
            )}
            {grpLoad && memberGroups === null ? (
              <Box textAlign="center" padding="m">
                <Spinner />
              </Box>
            ) : (
              <>
                <Table
                  variant="embedded"
                  loading={grpLoad}
                  loadingText="Loading groups"
                  columnDefinitions={[
                    {
                      id: "name",
                      header: "Group",
                      cell: (g: AgentGroupMembership) => g.name,
                    },
                    {
                      id: "desc",
                      header: "Description",
                      cell: (g: AgentGroupMembership) => g.description?.trim() || "—",
                    },
                    {
                      id: "rm",
                      header: "",
                      width: 100,
                      cell: (g: AgentGroupMembership) => (
                        <Button
                          variant="link"
                          disabled={grpBusy}
                          onClick={() => removeAgentFromGroup(g.id)}
                        >
                          Remove
                        </Button>
                      ),
                    },
                  ]}
                  items={memberGroups ?? []}
                  empty={
                    <Box color="text-body-secondary">
                      Not in any group yet. Add this computer below or use bulk actions on the overview.
                    </Box>
                  }
                />
                <FormField label="Add to group">
                  <SpaceBetween direction="horizontal" size="xs">
                    <Select
                      selectedOption={
                        addGroupPick
                          ? addableGroupOptions.find((o) => o.value === addGroupPick) ?? null
                          : null
                      }
                      onChange={({ detail }) => {
                        const v = detail.selectedOption?.value;
                        setAddGroupPick(typeof v === "string" ? v : "");
                      }}
                      options={addableGroupOptions}
                      placeholder="Choose a group"
                      disabled={grpBusy || addableGroupOptions.length === 0}
                      filteringType="auto"
                      empty="No more groups — create one from All groups & alert rules."
                    />
                    <Button
                      disabled={!addGroupPick || grpBusy}
                      onClick={() => addAgentToSelectedGroup()}
                    >
                      Add
                    </Button>
                  </SpaceBetween>
                </FormField>
              </>
            )}
          </SpaceBetween>
        </Container>
      )}
            </SpaceBetween>
          )
        }] : []),
        {
          id: "retention",
          label: "Data Retention",
          content: (
            <SpaceBetween size="l">
              <Container
        header={
          <Header
            variant="h2"
            description="Optional per-device overrides. Leave blank to inherit the global default."
          >
            Retention overrides
          </Header>
        }
      >
        {load ? (
          <Box textAlign="center" padding="l">
            <Spinner size="large" />
          </Box>
        ) : (
          <SpaceBetween size="l">
            {err && (
              <Alert type="error" dismissible onDismiss={() => setErr(null)}>
                {err}
              </Alert>
            )}
            {ok && (
              <Alert type="success" dismissible onDismiss={() => setOk(null)}>
                {ok}
              </Alert>
            )}

            {agGlobal ? (
              <KeyValuePairs
                columns={3}
                items={[
                  { label: "Default keylogs", value: fmtRetentionBrief(agGlobal.keylog_days) },
                  { label: "Default windows", value: fmtRetentionBrief(agGlobal.window_days) },
                  { label: "Default URLs", value: fmtRetentionBrief(agGlobal.url_days) },
                  ...effectiveItems.map((x) => ({ label: `Effective ${x.label.toLowerCase()}`, value: x.value })),
                ]}
              />
            ) : null}

            <ColumnLayout columns={3} variant="text-grid">
              <RetentionOverrideField
                title="Keylogs"
                description="How long to keep keystroke sessions on this PC."
                value={agKey}
                onChange={setAgKey}
                globalDays={agGlobal?.keylog_days}
                parsed={parsedKey}
                formDisabled={save}
              />
              <RetentionOverrideField
                title="Windows"
                description="How long to keep focused windows and activity events."
                value={agWin}
                onChange={setAgWin}
                globalDays={agGlobal?.window_days}
                parsed={parsedWin}
                formDisabled={save}
              />
              <RetentionOverrideField
                title="URLs"
                description="How long to keep browser URL history on this PC."
                value={agUrl}
                onChange={setAgUrl}
                globalDays={agGlobal?.url_days}
                parsed={parsedUrl}
                formDisabled={save}
              />
            </ColumnLayout>

            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="primary"
                disabled={save || hasRetentionErrors}
                loading={save}
                onClick={saveOverrides}
              >
                Save overrides
              </Button>
              <Button disabled={save} onClick={clearOverrides}>
                Remove overrides
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        )}
      </Container>
            </SpaceBetween>
          )
        },
        {
          id: "security",
          label: "Security",
          content: (
            <SpaceBetween size="l">
              {!load && (
        <Container
          header={
            <Header
              variant="h2"
              description={`${agentName} — lock for the Windows agent’s on-machine Vantyr settings (not this dashboard).`}
            >
              Local settings window password
            </Header>
          }
        >
          <SpaceBetween size="l">
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: "Global default (Preferences)",
                  value: localUiGlobalSet
                    ? "Password required for the local settings window."
                    : "No password — local settings open by default.",
                },
                {
                  label: "This computer",
                  value:
                    localUiOverride === null
                      ? "Follows the global default above."
                      : localUiOverride.password_set
                        ? "Override: password set for this PC."
                        : "Override: no password (open) for this PC.",
                },
              ]}
            />

            {localUiErr && (
              <Alert type="error" dismissible onDismiss={() => setLocalUiErr(null)}>
                {localUiErr}
              </Alert>
            )}
            {localUiOk && (
              <Alert type="success" dismissible onDismiss={() => setLocalUiOk(null)}>
                {localUiOk}
              </Alert>
            )}

            <FormField label="New password (override)">
              <Input
                type="password"
                autoComplete="new-password"
                value={localUiPwd}
                onChange={({ detail }) => setLocalUiPwd(detail.value)}
                disabled={localUiSave}
                placeholder="Leave empty with confirm empty to force an open window"
              />
            </FormField>
            <FormField label="Confirm password">
              <Input
                type="password"
                autoComplete="new-password"
                value={localUiPwd2}
                onChange={({ detail }) => setLocalUiPwd2(detail.value)}
                disabled={localUiSave}
              />
            </FormField>

            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="primary"
                loading={localUiSave}
                disabled={localUiSave}
                onClick={saveLocalUiOverride}
              >
                Save override
              </Button>
              <Button
                disabled={localUiSave || localUiOverride === null}
                onClick={clearLocalUiOverride}
              >
                Use global default only
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>
      )}
            </SpaceBetween>
          )
        },
        {
          id: "updates",
          label: "Updates",
          content: (
            <SpaceBetween size="l">
              {!load && (
        <Container
          header={
            <Header
              variant="h2"
              description={`${agentName} — trigger an immediate update check and install (requires the agent to be online).`}
            >
              Update agent
            </Header>
          }
        >
          <SpaceBetween size="l">
            <KeyValuePairs
              columns={1}
              items={[
                { label: "Installed version", value: agentVersion ?? "—" },
                { label: "Latest available", value: latestAgentVersion ?? "—" },
                {
                  label: "Status",
                  value: isOutOfDate ? "Out of date" : "Up to date (or unknown)",
                },
              ]}
            />

            {updNowErr && (
              <Alert type="error" dismissible onDismiss={() => setUpdNowErr(null)}>
                {updNowErr}
              </Alert>
            )}
            {updNowOk && (
              <Alert type="success" dismissible onDismiss={() => setUpdNowOk(null)}>
                {updNowOk}
              </Alert>
            )}

            {agentOnline ? (
              <Button
                variant={isOutOfDate ? "primary" : "normal"}
                disabled={updNow}
                loading={updNow}
                onClick={triggerUpdateNow}
              >
                Update now
              </Button>
            ) : (
              <Box fontSize="body-s" color="text-body-secondary">
                Agent is offline. Connect the agent to trigger updates.
              </Box>
            )}
          </SpaceBetween>
        </Container>
      )}
              {!load && (
        <Container
          header={
            <Header
              variant="h2"
              description={`${agentName} — control whether the Windows agent self-updates from GitHub Releases.`}
            >
              Agent auto updates
            </Header>
          }
        >
          <SpaceBetween size="l">
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: "Global default (Settings → About)",
                  value:
                    autoUpdGlobal == null
                      ? "—"
                      : autoUpdGlobal
                        ? "Enabled"
                        : "Disabled",
                },
                {
                  label: "This computer",
                  value:
                    autoUpdOverride === null
                      ? "Follows the global default above."
                      : autoUpdOverride.enabled
                        ? "Override: enabled"
                        : "Override: disabled",
                },
              ]}
            />

            {autoUpdErr && (
              <Alert type="error" dismissible onDismiss={() => setAutoUpdErr(null)}>
                {autoUpdErr}
              </Alert>
            )}
            {autoUpdOk && (
              <Alert type="success" dismissible onDismiss={() => setAutoUpdOk(null)}>
                {autoUpdOk}
              </Alert>
            )}

            <FormField
              label="Override for this computer"
              description="When enabled, the agent will periodically check for updates and install them."
            >
              <Toggle
                checked={autoUpdOverride?.enabled ?? autoUpdGlobal ?? true}
                disabled={autoUpdLoad || autoUpdSave}
                onChange={({ detail }) => saveAutoUpdateOverride(detail.checked)}
              >
                Enable auto updates
              </Toggle>
            </FormField>

            {autoUpdOverride !== null ? (
              <Button disabled={autoUpdSave} onClick={clearAutoUpdateOverride}>
                Use global default only
              </Button>
            ) : null}
          </SpaceBetween>
        </Container>
      )}
            </SpaceBetween>
          )
        }
      ]}
    />
  );
}
