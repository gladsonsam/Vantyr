import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  Download,
  FolderOpen,
  KeyRound,
  Loader2,
  Logs,
  Network,
  Power,
  RefreshCw,
  Save,
  Search,
  Shield,
  Trash,
  Trash2,
} from "lucide-react";
import type {
  AgentConfig,
  DiscoveredServer,
  LogSourceDesc,
  ManualApplyUpdateResponse,
  ManualUpdateCheckResponse,
  NavId,
  StatusResponse,
  UpdateDialogState,
} from "../types";
import {
  ConnectionStatus,
  Field,
  Notice,
  Spinner,
  TextInput,
  Toggle,
} from "./AgentUi";
import { ClearAllLogsModal, ExitModal, UpdateModal } from "./SettingsModals";
import { invoke } from "../lib/tauri";
import { cn, getErrorMessage } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type ModuleState = { module: string; enabled: boolean; available: boolean; revision: number };
function ModulePermissions() {
  const [modules, setModules] = useState<ModuleState[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => invoke<{ modules: ModuleState[] }>("get_module_permissions")
      .then((state) => { if (active) setModules(state.modules); })
      .catch((e: unknown) => { if (active) setError(getErrorMessage(e)); });
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function change(module: string, enabled: boolean) {
    setBusy(true); setError("");
    try {
      const state = await invoke<{ modules: ModuleState[] }>("set_module_permission", { module, enabled });
      setModules(state.modules);
    } catch (e) { setError(getErrorMessage(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-[15px] font-semibold">Modules</h3>
      <p className="mb-2 text-[13px] text-muted-foreground">
        Only this device can turn modules on.
      </p>
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      {modules.map((m) => (
        <Label
          key={m.module}
          className="flex items-center gap-3 py-1 text-sm font-normal"
        >
          <Checkbox
            checked={m.enabled}
            disabled={busy || !m.available}
            onCheckedChange={(checked) => void change(m.module, checked)}
          />
          <span>
            {m.module.replaceAll("_", " ")}
            {!m.available && " (unavailable)"}
          </span>
        </Label>
      ))}
    </div>
  );
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: Activity, description: "" },
  { id: "connection", label: "Connection", icon: Network, description: "" },
  { id: "security", label: "Security", icon: Shield, description: "" },
  { id: "logs", label: "Logs", icon: Logs, description: "" },
] satisfies Array<{ id: NavId; label: string; icon: typeof Activity; description: string }>;

function defaultConfig(): AgentConfig {
  return {
    server_url: "",
    agent_name: "",
    agent_token: "",
    install_id: "",
    ui_password_hash: "",
    auto_update_enabled: false,
    tray_icon_enabled: true,
  };
}

export function SettingsPanel() {
  const [nav, setNav] = useState<NavId>("dashboard");
  const [config, setConfig] = useState<AgentConfig>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [status, setStatus] = useState<StatusResponse>({ status: "Disconnected" });
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState>(null);
  const [adoptCode, setAdoptCode] = useState("");
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptMsg, setAdoptMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [logSources, setLogSources] = useState<LogSourceDesc[]>([]);
  const [logSourceId, setLogSourceId] = useState("");
  const [logText, setLogText] = useState("");
  const [logsManualRefresh, setLogsManualRefresh] = useState(false);
  const [logClearing, setLogClearing] = useState(false);
  const [logClearMsg, setLogClearMsg] = useState<string | null>(null);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitPw, setExitPw] = useState("");
  const [exitBusy, setExitBusy] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);

  const serverUrlInputRef = useRef<HTMLInputElement | null>(null);
  const saveMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logViewportRef = useRef<HTMLTextAreaElement | null>(null);
  const logStickToBottomRef = useRef(true);
  const logInitialScrollDoneRef = useRef(false);
  const clearMenuRef = useRef<HTMLDivElement | null>(null);

  const activeNav = useMemo(() => NAV_ITEMS.find((item) => item.id === nav) ?? NAV_ITEMS[0], [nav]);
  const currentLogSourceId = useMemo(() => {
    if (logSources.length === 0) return logSourceId;
    if (logSources.some((source) => source.id === logSourceId)) return logSourceId;
    return logSources[0].id;
  }, [logSources, logSourceId]);

  useEffect(() => {
    invoke<AgentConfig>("get_config")
      .then((cfg) => setConfig(cfg))
      .catch(() => setConfig(defaultConfig()))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (nav !== "connection") return;
    const id = setTimeout(() => serverUrlInputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [nav]);

  useEffect(() => {
    const poll = async () => {
      try {
        setStatus(await invoke<StatusResponse>("get_status"));
      } catch {
        setStatus({ status: "Error", message: "IPC unavailable" });
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    invoke<string>("get_app_version").then(setAppVersion).catch(() => setAppVersion(""));
    void invoke<LogSourceDesc[]>("list_log_sources").then(setLogSources).catch(() => setLogSources([]));
  }, []);

  const refreshLogs = useCallback(
    async (manual: boolean) => {
      if (manual) setLogsManualRefresh(true);
      try {
        setLogText(await invoke<string>("read_log_file_tail", { kind: currentLogSourceId, maxKb: 512 }));
      } catch (error: unknown) {
        setLogText(`(Could not read log: ${getErrorMessage(error)})`);
      } finally {
        if (manual) setLogsManualRefresh(false);
      }
    },
    [currentLogSourceId],
  );

  useEffect(() => {
    if (nav !== "logs") return;
    logStickToBottomRef.current = true;
    logInitialScrollDoneRef.current = false;
    // Loading the log tail when the Logs pane opens is exactly what an effect is
    // for, and `refreshLogs` only touches state after awaiting the IPC read. The
    // rule flags any effect that transitively sets state, so it can't see that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshLogs(false);
  }, [nav, currentLogSourceId, refreshLogs]);

  useEffect(() => {
    if (nav !== "logs") return;
    const id = setInterval(() => void refreshLogs(false), 2000);
    return () => clearInterval(id);
  }, [nav, refreshLogs]);

  useEffect(() => {
    const el = logViewportRef.current;
    if (!el) return;
    if (!logInitialScrollDoneRef.current) {
      el.scrollTop = el.scrollHeight;
      logInitialScrollDoneRef.current = true;
      return;
    }
    if (logStickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logText]);

  useEffect(() => {
    if (!clearMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!clearMenuRef.current?.contains(e.target as Node)) setClearMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [clearMenuOpen]);

  const handleSave = useCallback(async () => {
    if (newPw && newPw !== confirmPw) {
      setSaveMsg({ text: "Passwords don't match", ok: false });
      return;
    }
    setSaving(true);
    try {
      const payload: AgentConfig & { new_password?: string } = { ...config, ...(newPw ? { new_password: newPw } : {}) };
      await invoke("save_config", { config: payload });
      setSaveMsg({ text: "Settings saved.", ok: true });
      setNewPw("");
      setConfirmPw("");
      setConfig(await invoke<AgentConfig>("get_config"));
    } catch (error: unknown) {
      setSaveMsg({ text: `Save failed: ${getErrorMessage(error)}`, ok: false });
    } finally {
      setSaving(false);
      if (saveMsgTimer.current) clearTimeout(saveMsgTimer.current);
      saveMsgTimer.current = setTimeout(() => setSaveMsg(null), 4000);
    }
  }, [config, newPw, confirmPw]);

  const handleRemovePassword = useCallback(async () => {
    setSaving(true);
    try {
      const payload: AgentConfig & { new_password?: string } = { ...config, new_password: "" };
      await invoke("save_config", { config: payload });
      setSaveMsg({ text: "Password protection removed.", ok: true });
      setNewPw("");
      setConfirmPw("");
      setConfig(await invoke<AgentConfig>("get_config"));
    } catch (error: unknown) {
      setSaveMsg({ text: `Failed to remove password: ${getErrorMessage(error)}`, ok: false });
    } finally {
      setSaving(false);
      if (saveMsgTimer.current) clearTimeout(saveMsgTimer.current);
      saveMsgTimer.current = setTimeout(() => setSaveMsg(null), 4000);
    }
  }, [config]);

  const clearLogs = useCallback(async () => {
    setLogClearing(true);
    setLogClearMsg(null);
    try {
      await invoke("clear_log_file", { kind: currentLogSourceId });
      setLogText("");
      setLogClearMsg("Cleared.");
    } catch (error: unknown) {
      setLogClearMsg(getErrorMessage(error));
    } finally {
      setLogClearing(false);
      setTimeout(() => setLogClearMsg(null), 3000);
    }
  }, [currentLogSourceId]);

  const clearAllLogs = useCallback(async () => {
    if (logSources.length === 0) return;
    setLogClearing(true);
    setLogClearMsg(null);
    try {
      await Promise.allSettled(logSources.map((source) => invoke("clear_log_file", { kind: source.id })));
      void refreshLogs(false);
      setLogClearMsg("All logs cleared.");
    } finally {
      setLogClearing(false);
      setTimeout(() => setLogClearMsg(null), 3000);
    }
  }, [logSources, refreshLogs]);

  const openUpdateCheck = useCallback(async () => {
    setUpdateDialog({ phase: "checking" });
    try {
      const result = await invoke<ManualUpdateCheckResponse>("check_manual_update");
      setUpdateDialog(
        result.update_available && result.published_version
          ? { phase: "available", publishedVersion: result.published_version }
          : { phase: "uptodate" },
      );
    } catch (error: unknown) {
      setUpdateDialog({ phase: "error", message: getErrorMessage(error) });
    }
  }, []);

  const applyManualUpdate = useCallback(async () => {
    setUpdateDialog({ phase: "installing" });
    try {
      const result = await invoke<ManualApplyUpdateResponse>("apply_manual_update");
      if (result.outcome === "up_to_date") setUpdateDialog({ phase: "uptodate" });
    } catch (error: unknown) {
      setUpdateDialog({ phase: "error", message: getErrorMessage(error) });
    }
  }, []);

  const scanLanServers = useCallback(async () => {
    setScanning(true);
    setAdoptMsg(null);
    try {
      const list = await invoke<DiscoveredServer[]>("discover_vantyr_mdns_servers", { opts: { timeoutMs: 4000 } });
      setDiscovered(list);
      if (list.length === 1) {
        setConfig((current) => ({ ...current, server_url: list[0].wssUrl }));
        setAdoptMsg({ text: "Server found.", ok: true });
      } else if (list.length === 0) {
        setAdoptMsg({ text: "No servers found. Enter the wss:// URL.", ok: false });
      } else {
        setAdoptMsg({ text: `Found ${list.length} servers. Pick one in the list.`, ok: true });
      }
    } catch (error: unknown) {
      setAdoptMsg({ text: `Discovery failed: ${getErrorMessage(error)}`, ok: false });
    } finally {
      setScanning(false);
    }
  }, []);

  const adoptWithCode = useCallback(async () => {
    const url = config.server_url.trim();
    if (!url.startsWith("wss://")) {
      setAdoptMsg({ text: "Server URL must start with wss://", ok: false });
      return;
    }
    setAdoptBusy(true);
    setAdoptMsg(null);
    try {
      const agentName = config.agent_name.trim();
      await invoke("adopt_with_enrollment_code", {
        payload: { serverUrl: url, enrollmentCode: adoptCode.trim(), agentName: agentName.length > 0 ? agentName : null },
      });
      setAdoptCode("");
      setConfig(await invoke<AgentConfig>("get_config"));
      setAdoptMsg({ text: "Approved.", ok: true });
    } catch (error: unknown) {
      setAdoptMsg({ text: getErrorMessage(error), ok: false });
    } finally {
      setAdoptBusy(false);
    }
  }, [config.server_url, config.agent_name, adoptCode]);

  const handleExit = useCallback(() => {
    void (async () => {
      try {
        if (await invoke<boolean>("has_ui_password")) {
          setExitDialogOpen(true);
          return;
        }
        await invoke("exit_agent");
      } catch {
        // Ignore exit failures in the UI shell.
      }
    })();
  }, []);

  const confirmExit = useCallback(async () => {
    setExitBusy(true);
    setExitError(null);
    try {
      await invoke("verify_ui_password", { password: exitPw });
      await invoke("exit_agent");
    } catch (error: unknown) {
      setExitError(getErrorMessage(error) || "Authentication required");
      setExitPw("");
    } finally {
      setExitBusy(false);
    }
  }, [exitPw]);

  if (loading) {
    return (
      <main className="grid h-full place-items-center text-muted-foreground">
        <Spinner className="size-6" />
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0 flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">Vantyr Agent</h1>
            <p className="text-[13px] text-muted-foreground">
              {appVersion ? `v${appVersion}` : "Local settings"}
            </p>
          </div>
        </div>
        <Button variant="ghost" onClick={() => void openUpdateCheck()}>
          <Download size={16} aria-hidden="true" />
          Updates
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-56 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground"
        >
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = nav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setNav(item.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col gap-6 p-6",
            nav === "logs" ? "overflow-hidden" : "overflow-auto",
          )}
        >
          <div className="shrink-0">
            <h2 className="text-xl font-medium tracking-tight">{activeNav.label}</h2>
            {activeNav.description && <p className="mt-1 text-sm text-muted-foreground">{activeNav.description}</p>}
          </div>

          {nav === "dashboard" && (
            <Card className="max-w-2xl p-6">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted-foreground">Connection</span>
                  <ConnectionStatus {...status} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted-foreground">Agent name</span>
                  <span className="text-sm font-medium break-all">
                    {config.agent_name.trim() || "—"}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted-foreground">Server URL</span>
                  <span className="text-sm font-medium break-all">
                    {config.server_url.trim() || "—"}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted-foreground">Updates</span>
                  <span>
                    <Button variant="secondary" onClick={() => void openUpdateCheck()}>
                      <RefreshCw size={16} aria-hidden="true" />
                      Check for updates
                    </Button>
                  </span>
                </div>
              </div>
            </Card>
          )}

          {nav === "connection" && (
            <div className="grid items-start gap-6 xl:grid-cols-2">
              <Card className="p-6">
                <CardHeader className="px-0 pt-0">
                  <CardTitle>Enrollment</CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <div className="flex flex-col gap-5">
                    <Field label="Server URL">
                      <TextInput
                        ref={serverUrlInputRef}
                        value={config.server_url}
                        onChange={(event) => setConfig((current) => ({ ...current, server_url: event.currentTarget.value }))}
                        placeholder="wss://host/ws/agent"
                      />
                    </Field>
                    {discovered.length > 1 && (
                      <div className="flex w-full flex-col gap-2">
                        <Label>Found servers</Label>
                        <Select
                          value=""
                          onValueChange={(value) => {
                            if (value) {
                              setConfig((current) => ({ ...current, server_url: value }));
                            }
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select discovered server" />
                          </SelectTrigger>
                          <SelectContent>
                            {discovered.map((server) => (
                              <SelectItem key={server.wssUrl} value={server.wssUrl}>
                                {(server.instanceName?.trim() || server.wssUrl) +
                                  (server.instanceName?.trim() ? ` — ${server.wssUrl}` : "")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <span>
                      <Button variant="secondary" disabled={scanning} onClick={() => void scanLanServers()}>
                        {scanning ? (
                          <Loader2 size={16} aria-hidden="true" className="animate-spin" />
                        ) : (
                          <Search size={16} aria-hidden="true" />
                        )}
                        Find on network
                      </Button>
                    </span>
                    <Field label="Pairing code">
                      <TextInput
                        value={adoptCode}
                        onChange={(event) => setAdoptCode(event.currentTarget.value)}
                        placeholder="Optional"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                      />
                    </Field>
                    <span>
                      <Button variant="default" disabled={adoptBusy} onClick={() => void adoptWithCode()}>
                        {adoptBusy ? (
                          <Loader2 size={16} aria-hidden="true" className="animate-spin" />
                        ) : (
                          <KeyRound size={16} aria-hidden="true" />
                        )}
                        Request access
                      </Button>
                    </span>
                    {adoptMsg && (
                      <Notice tone={adoptMsg.ok ? "success" : "error"} title={adoptMsg.ok ? "Done" : "Notice"}>
                        {adoptMsg.text}
                      </Notice>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="p-6">
                <CardHeader className="px-0 pt-0">
                  <CardTitle>Credentials</CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <div className="flex flex-col gap-5">
                    <Field label="Agent name">
                      <TextInput
                        value={config.agent_name}
                        onChange={(event) => setConfig((current) => ({ ...current, agent_name: event.currentTarget.value }))}
                        placeholder="My-PC"
                      />
                    </Field>
                    <Field label="Agent token">
                      <TextInput
                        value={config.agent_token}
                        onChange={(event) => setConfig((current) => ({ ...current, agent_token: event.currentTarget.value }))}
                        type="password"
                        placeholder="Issued by approval"
                        autoComplete="new-password"
                      />
                    </Field>
                    <Toggle checked={config.auto_update_enabled} onChange={(checked) => setConfig((c) => ({ ...c, auto_update_enabled: checked }))}>
                      Auto-update agent
                    </Toggle>
                    <Toggle checked={config.tray_icon_enabled} onChange={(checked) => setConfig((c) => ({ ...c, tray_icon_enabled: checked }))}>
                      Show tray icon
                    </Toggle>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {nav === "security" && (
            <div className="flex max-w-2xl flex-col gap-6">
              <Card className="p-6">
                <ModulePermissions />
              </Card>
              <Card className="p-6">
                <CardHeader className="px-0 pt-0">
                  <CardTitle>Password</CardTitle>
                  <CardDescription>Leave blank to keep the current one.</CardDescription>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <div className="flex flex-col gap-5">
                    <Field label="New password">
                      <TextInput value={newPw} onChange={(event) => setNewPw(event.currentTarget.value)} type="password" />
                    </Field>
                    <Field label="Confirm password">
                      <TextInput value={confirmPw} onChange={(event) => setConfirmPw(event.currentTarget.value)} type="password" />
                    </Field>
                    {config.ui_password_hash && (
                      <span>
                        <Button variant="destructive" onClick={() => void handleRemovePassword()} disabled={saving}>
                          Remove password
                        </Button>
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {nav === "logs" && (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <Card className="shrink-0 p-6">
                <CardHeader className="px-0 pt-0">
                  <CardTitle>Logs</CardTitle>
                  <CardDescription>Last 512 KiB</CardDescription>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={logSources.length === 0 ? "" : currentLogSourceId}
                      onValueChange={(value) => setLogSourceId(value ?? "")}
                      disabled={logSources.length === 0}
                    >
                      <SelectTrigger className="min-w-44">
                        <SelectValue placeholder="No log sources" />
                      </SelectTrigger>
                      <SelectContent>
                        {logSources.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="secondary" disabled={logsManualRefresh} onClick={() => void refreshLogs(true)}>
                      {logsManualRefresh ? (
                        <Loader2 size={16} aria-hidden="true" className="animate-spin" />
                      ) : (
                        <RefreshCw size={16} aria-hidden="true" />
                      )}
                      Refresh
                    </Button>
                    <Button variant="secondary" onClick={() => void invoke("open_log_location", { kind: currentLogSourceId }).catch(() => {})}>
                      <FolderOpen size={16} aria-hidden="true" />
                      Open location
                    </Button>
                    <div className="relative ml-auto inline-flex" ref={clearMenuRef}>
                      <Button
                        variant="secondary"
                        disabled={logClearing}
                        onClick={() => void clearLogs()}
                        className="rounded-r-none border-r-0"
                      >
                        {logClearing ? (
                          <Loader2 size={16} aria-hidden="true" className="animate-spin" />
                        ) : (
                          <Trash2 size={16} aria-hidden="true" />
                        )}
                        Clear
                      </Button>
                      <Button
                        variant="secondary"
                        size="icon"
                        disabled={logClearing || logSources.length === 0}
                        onClick={() => setClearMenuOpen((o) => !o)}
                        aria-label="More clear options"
                        className="rounded-l-none"
                      >
                        <ChevronDown size={14} aria-hidden="true" />
                      </Button>
                      {clearMenuOpen && (
                        <div className="absolute top-full right-0 z-10 mt-1 min-w-40 rounded-lg border border-border bg-popover p-1 shadow-md">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap text-destructive hover:bg-destructive/10"
                            onClick={() => { setClearMenuOpen(false); setClearAllConfirmOpen(true); }}
                          >
                            <Trash size={14} aria-hidden="true" />
                            Clear all logs
                          </button>
                        </div>
                      )}
                    </div>
                    {logClearMsg && (
                      <span className="text-xs text-muted-foreground">{logClearMsg}</span>
                    )}
                  </div>
                </CardContent>
              </Card>
              <Textarea
                ref={logViewportRef}
                aria-label="Agent log output"
                value={logText || "Loading..."}
                readOnly
                spellCheck={false}
                wrap="off"
                onScroll={() => {
                  const el = logViewportRef.current;
                  if (!el) return;
                  logStickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
                }}
                className="min-h-0 flex-1 resize-none overflow-auto font-mono text-xs leading-relaxed whitespace-pre md:text-xs [field-sizing:fixed]"
              />
            </div>
          )}
        </section>
      </div>

      <footer className="flex min-h-[58px] shrink-0 items-center gap-2.5 border-t border-border bg-card px-4 py-2.5">
        <Button variant="default" disabled={saving} onClick={() => void handleSave()}>
          {saving ? (
            <Loader2 size={16} aria-hidden="true" className="animate-spin" />
          ) : (
            <Save size={16} aria-hidden="true" />
          )}
          Save
        </Button>
        <Button variant="ghost" onClick={() => void invoke("hide_window").catch(() => {})}>
          Hide
        </Button>
        {saveMsg && (
          <span className={cn("text-xs", saveMsg.ok ? "text-success" : "text-destructive")}>
            {saveMsg.text}
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-ellipsis whitespace-nowrap text-muted-foreground">
          Reopen with <Kbd>Ctrl+Shift+F12</Kbd>
        </span>
        <Button variant="secondary" onClick={handleExit}>
          <Power size={16} aria-hidden="true" />
          Exit agent
        </Button>
      </footer>

      <ExitModal
        open={exitDialogOpen}
        busy={exitBusy}
        error={exitError}
        password={exitPw}
        onPassword={setExitPw}
        onClose={() => {
          setExitDialogOpen(false);
          setExitPw("");
          setExitError(null);
        }}
        onConfirm={() => void confirmExit()}
      />
      <ClearAllLogsModal
        open={clearAllConfirmOpen}
        busy={logClearing}
        sources={logSources}
        onClose={() => setClearAllConfirmOpen(false)}
        onConfirm={() => {
          setClearAllConfirmOpen(false);
          void clearAllLogs();
        }}
      />
      <UpdateModal
        dialog={updateDialog}
        onClose={() => setUpdateDialog((dialog) => (dialog?.phase === "installing" ? dialog : null))}
        onApply={() => void applyManualUpdate()}
      />
    </main>
  );
}
